import { Effect } from "effect";
import type { CommandResult } from "../../agent/hints.js";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import {
  type Concept,
  TaxonomyService,
} from "../../services/TaxonomyService.js";
import {
  SearchOptions,
  SemanticSearchProviderError,
  type DocumentSearchResult,
} from "../../types.js";
import {
  CLIError,
  runCommandWithContext,
  splitPositionalsAndFlags,
  type CliLibrary,
  type CommandBodyOutput,
  type CommandExecutionContext,
  type GlobalCLIOptions,
} from "../runner.js";

interface SearchCommandOptions extends Record<string, unknown> {
  limit?: string | number;
  tag?: string;
  fts?: boolean;
  expand?: string | number;
  "docs-only"?: boolean;
  docsOnly?: boolean;
  "concepts-only"?: boolean;
  conceptsOnly?: boolean;
  "include-clusters"?: boolean;
  includeClusters?: boolean;
  "with-content"?: boolean;
  withContent?: boolean;
  "global-limit"?: string | number;
  globalLimit?: string | number;
}

export type SearchDocumentOutput = {
  chunkId: string;
  docId: string;
  title: string;
  page: number;
  score: number;
  matchType: DocumentSearchResult["matchType"];
  content: string;
  diagnostics?: {
    chunkIndex: number;
    rawScore: number;
    scoreType: DocumentSearchResult["scoreType"];
    vectorScore?: number;
    ftsRank?: number;
    expandedRange?: { start: number; end: number };
  };
};

type DocumentRetrievalMode = "hybrid" | "fts";
type RetrievalMode = DocumentRetrievalMode | "none";

type CommonSearchOptions = {
  limit: number;
  tags: string[] | undefined;
  ftsOnly: boolean;
  expandChars: number;
};

type ChunkHandle = {
  chunkId: string;
  docId: string;
  title: string;
  page: number;
  score: number;
  matchType: DocumentSearchResult["matchType"];
  content?: string;
  diagnostics?: SearchDocumentOutput["diagnostics"];
};

type DedupedChunkHandle = ChunkHandle & {
  matchedQueries: string[];
};

type SearchFlag =
  | readonly ["concepts-only", "conceptsOnly"]
  | readonly ["docs-only", "docsOnly"]
  | readonly ["include-clusters", "includeClusters"]
  | readonly ["with-content", "withContent"];

const SEARCH_FLAGS = {
  conceptsOnly: ["concepts-only", "conceptsOnly"],
  docsOnly: ["docs-only", "docsOnly"],
  includeClusters: ["include-clusters", "includeClusters"],
  withContent: ["with-content", "withContent"],
} as const satisfies Record<string, SearchFlag>;

function parseCommonSearchOptions(
  options: SearchCommandOptions,
): CommonSearchOptions {
  return {
    limit: options.limit ? Number.parseInt(String(options.limit), 10) : 10,
    tags: options.tag ? [String(options.tag)] : undefined,
    ftsOnly: options.fts === true,
    expandChars: options.expand
      ? Math.min(
          4000,
          Math.max(0, Number.parseInt(String(options.expand), 10)),
        )
      : 0,
  };
}

function isEnabled(
  options: SearchCommandOptions,
  [dashedName, camelName]: SearchFlag,
): boolean {
  return options[dashedName] === true || options[camelName] === true;
}

function documentRetrievalMode(ftsOnly: boolean): DocumentRetrievalMode {
  return ftsOnly ? "fts" : "hybrid";
}

function searchModeLabel(conceptsOnly: boolean, docsOnly: boolean): string {
  if (conceptsOnly) return " (concepts only)";
  if (docsOnly) return " (docs only)";
  return "";
}

function mapSemanticSearchFailure(error: unknown): unknown {
  if (!(error instanceof SemanticSearchProviderError)) {
    return error;
  }

  return new CLIError(
    "PROVIDER_NOT_READY",
    `Embedding provider not ready (${error.provider}): ${error.reason}`,
    {
      provider: error.provider,
      reason: error.reason,
      requestedRetrievalMode: "hybrid" satisfies DocumentRetrievalMode,
    },
  );
}

function searchDocuments(
  library: CliLibrary,
  query: string,
  options: SearchOptions,
  retrievalMode: DocumentRetrievalMode,
) {
  const search =
    retrievalMode === "fts"
      ? library.ftsSearch(query, options)
      : library.search(query, options);

  return search.pipe(Effect.mapError(mapSemanticSearchFailure));
}

export function toSearchDocumentOutput(
  result: DocumentSearchResult,
  expandChars: number,
  verbose = false,
): SearchDocumentOutput {
  const output: SearchDocumentOutput = {
    chunkId: result.chunkId,
    docId: result.docId,
    title: result.title,
    page: result.page,
    score: result.score,
    matchType: result.matchType,
    content:
      expandChars > 0
        ? result.expandedContent ?? result.content
        : result.content,
  };

  if (verbose) {
    output.diagnostics = {
      chunkIndex: result.chunkIndex,
      rawScore: result.rawScore,
      scoreType: result.scoreType,
      ...(result.vectorScore !== undefined
        ? { vectorScore: result.vectorScore }
        : {}),
      ...(result.ftsRank !== undefined ? { ftsRank: result.ftsRank } : {}),
      ...(expandChars > 0 && result.expandedRange
        ? { expandedRange: result.expandedRange }
        : {}),
    };
  }

  return output;
}

function matchesConcept(concept: Concept, query: string): boolean {
  return (
    concept.prefLabel.toLowerCase().includes(query) ||
    concept.altLabels.some((label) => label.toLowerCase().includes(query)) ||
    concept.definition?.toLowerCase().includes(query) === true
  );
}

function findConcepts(query: string, limit: number) {
  return Effect.gen(function* () {
    const taxonomy = yield* TaxonomyService;
    const embedProvider = yield* EmbeddingProvider;
    const healthCheck = yield* Effect.either(embedProvider.checkHealth());

    if (healthCheck._tag === "Right") {
      const queryEmbedding = yield* embedProvider.embed(query);
      return yield* taxonomy.findSimilarConcepts(queryEmbedding, 0.3, limit);
    }

    const queryLower = query.toLowerCase();
    const allConcepts = yield* taxonomy.listConcepts();
    return allConcepts
      .filter((concept) => matchesConcept(concept, queryLower))
      .slice(0, limit);
  }).pipe(Effect.catchAll(() => Effect.succeed([] as Concept[])));
}

function renderConceptResults(
  Console: CommandExecutionContext["Console"],
  concepts: Concept[],
) {
  return Effect.gen(function* () {
    if (concepts.length === 0) {
      return;
    }

    yield* Console.log(`Concepts (${concepts.length}):\n`);
    for (const concept of concepts) {
      yield* Console.log(`- ${concept.prefLabel} (${concept.id})`);
      if (concept.definition) {
        const definition = concept.definition.slice(0, 150).replace(/\n/g, " ");
        const suffix = concept.definition.length > 150 ? "..." : "";
        yield* Console.log(`    ${definition}${suffix}`);
      }
      yield* Console.log("");
    }
  });
}

function renderDocumentResults(
  Console: CommandExecutionContext["Console"],
  results: DocumentSearchResult[],
  expandChars: number,
  searchConcepts: boolean,
) {
  return Effect.gen(function* () {
    if (results.length === 0) {
      if (!searchConcepts) {
        yield* Console.log("No results found");
      }
      return;
    }

    if (searchConcepts) {
      yield* Console.log(`Documents (${results.length}):\n`);
    }

    for (const result of results) {
      yield* Console.log(
        `[${result.score.toFixed(3)}|${result.matchType}] ${result.title} (p.${result.page}) [chunk:${result.chunkId}]`,
      );

      if (!result.expandedContent) {
        yield* Console.log(
          `  ${result.content.slice(0, 200).replace(/\n/g, " ")}...`,
        );
        yield* Console.log("");
        continue;
      }

      const content = result.expandedContent.replace(/\n/g, "\n  ");
      if (expandChars > 0) {
        yield* Console.log(`  ${content}`);
      } else {
        const truncated =
          content.length > 500 ? `${content.slice(0, 500)}...` : content;
        yield* Console.log(`  ${truncated}`);
      }
      yield* Console.log("");
    }
  });
}

function runSingleSearch(
  context: CommandExecutionContext,
  options: SearchCommandOptions,
) {
  return Effect.gen(function* () {
    const { Console, globals, library } = context;
    const query = context.args[1];
    if (!query) {
      yield* Console.error("Error: Query required");
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", "Query required", { command: "search" }),
      );
    }

    const { limit, tags, ftsOnly, expandChars } =
      parseCommonSearchOptions(options);
    const conceptsOnly = isEnabled(options, SEARCH_FLAGS.conceptsOnly);
    const docsOnly = isEnabled(options, SEARCH_FLAGS.docsOnly);
    const includeClusters = isEnabled(options, SEARCH_FLAGS.includeClusters);
    const searchDocs = !conceptsOnly;
    const searchConcepts = !docsOnly;
    const documentMode = documentRetrievalMode(ftsOnly);
    const retrievalMode: RetrievalMode = searchDocs ? documentMode : "none";
    const modeLabel = searchModeLabel(conceptsOnly, docsOnly);

    yield* Console.log(
      `Searching: "${query}"${ftsOnly ? " (FTS only)" : ""}${modeLabel}${
        expandChars > 0 ? ` (expand: ${expandChars} chars)` : ""
      }\n`,
    );

    const conceptResults = searchConcepts
      ? yield* findConcepts(query, limit)
      : [];
    if (searchConcepts) {
      yield* renderConceptResults(Console, conceptResults);
    }

    const results = searchDocs
      ? yield* searchDocuments(
          library,
          query,
          new SearchOptions({
            limit,
            tags,
            hybrid: !ftsOnly,
            expandChars,
            includeClusterSummaries: includeClusters,
          }),
          documentMode,
        )
      : [];
    const documents = results.map((result) =>
      toSearchDocumentOutput(result, expandChars, globals.verbose),
    );
    if (searchDocs) {
      yield* renderDocumentResults(
        Console,
        results,
        expandChars,
        searchConcepts,
      );
    }

    const concepts = conceptResults.map((concept) => ({
      id: concept.id,
      prefLabel: concept.prefLabel,
      ...(concept.definition ? { definition: concept.definition } : {}),
      ...(globals.verbose ? { altLabels: [...concept.altLabels] } : {}),
    }));
    const compactPayload = { retrievalMode, concepts, documents };
    const resultPayload = globals.verbose
      ? {
          query,
          options: {
            limit,
            tags: tags ?? null,
            ftsOnly,
            expandChars,
            conceptsOnly,
            docsOnly,
            includeClusters,
          },
          ...compactPayload,
        }
      : compactPayload;
    const agentResult: CommandResult = {
      _tag: "search",
      query,
      results: results.map((result) => ({
        title: result.title,
        docId: result.docId,
        chunkId: result.chunkId,
        score: result.score,
      })),
      concepts: conceptResults.map((concept) => ({
        id: concept.id,
        prefLabel: concept.prefLabel,
      })),
      hadExpand: expandChars > 0,
      wasFts: ftsOnly,
    };

    return { resultPayload, agentResult } satisfies CommandBodyOutput;
  });
}

function readStdin() {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        let data = "";
        try {
          process.stdin.setEncoding("utf8");
        } catch {
          // Keep reading if the stream encoding was already configured.
        }
        process.stdin.on("data", (chunk) => {
          data += String(chunk);
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
      }),
    catch: (error) =>
      new CLIError("IO_ERROR", "Failed to read stdin", {
        reason: String(error),
      }),
  });
}

function parseStdinQueries(input: string): string[] {
  return input
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function toChunkHandle(
  result: DocumentSearchResult,
  expandChars: number,
  verbose: boolean,
  withContent: boolean,
): ChunkHandle {
  const projected = toSearchDocumentOutput(result, expandChars, verbose);
  return {
    chunkId: projected.chunkId,
    docId: projected.docId,
    title: projected.title,
    page: projected.page,
    score: projected.score,
    matchType: projected.matchType,
    ...(withContent ? { content: projected.content } : {}),
    ...(projected.diagnostics
      ? { diagnostics: projected.diagnostics }
      : {}),
  };
}

function mergeSearchResults(
  perQuery: Array<{ query: string; documents: ChunkHandle[] }>,
  globalLimit: number | null,
): DedupedChunkHandle[] {
  const merged = new Map<
    string,
    { best: ChunkHandle; matchedQueries: Set<string> }
  >();

  for (const { query, documents } of perQuery) {
    for (const document of documents) {
      const existing = merged.get(document.chunkId);
      if (!existing) {
        merged.set(document.chunkId, {
          best: document,
          matchedQueries: new Set([query]),
        });
        continue;
      }

      existing.matchedQueries.add(query);
      if (document.score > existing.best.score) {
        existing.best = document;
      }
    }
  }

  const deduped = Array.from(merged.values())
    .map(({ best, matchedQueries }) => ({
      ...best,
      matchedQueries: Array.from(matchedQueries).sort(),
    }))
    .sort((left, right) => right.score - left.score);

  return typeof globalLimit === "number" && !Number.isNaN(globalLimit)
    ? deduped.slice(0, globalLimit)
    : deduped;
}

function runSearchPack(
  context: CommandExecutionContext,
  options: SearchCommandOptions,
) {
  return Effect.gen(function* () {
    const { globals, library } = context;
    const { limit, tags, ftsOnly, expandChars } =
      parseCommonSearchOptions(options);
    const retrievalMode = documentRetrievalMode(ftsOnly);
    const withContent = isEnabled(options, SEARCH_FLAGS.withContent);
    const globalLimitRaw = options["global-limit"] ?? options.globalLimit;
    const globalLimit =
      globalLimitRaw !== undefined
        ? Math.max(1, Number.parseInt(String(globalLimitRaw), 10))
        : null;

    let queries = splitPositionalsAndFlags(context.args.slice(1)).positionals;
    if (queries.length === 0) {
      if (process.stdin.isTTY) {
        return yield* Effect.fail(
          new CLIError(
            "INVALID_ARGS",
            "search-pack requires queries as args or via stdin",
            {
              command: "search-pack",
              hint: 'poink search-pack "query one" "query two"',
            },
          ),
        );
      }
      queries = parseStdinQueries(yield* readStdin());
    }

    if (queries.length === 0) {
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", "No queries provided", {
          command: "search-pack",
        }),
      );
    }

    const perQuery: Array<{ query: string; documents: ChunkHandle[] }> = [];
    for (const query of queries) {
      const results = yield* searchDocuments(
        library,
        query,
        new SearchOptions({
          limit,
          tags,
          hybrid: !ftsOnly,
          expandChars,
        }),
        retrievalMode,
      );
      perQuery.push({
        query,
        documents: results.map((result) =>
          toChunkHandle(
            result,
            expandChars,
            globals.verbose,
            withContent,
          ),
        ),
      });
    }

    const deduped = mergeSearchResults(perQuery, globalLimit);
    const compactPayload = { retrievalMode, perQuery, deduped };
    const resultPayload = globals.verbose
      ? {
          queries,
          options: {
            limit,
            tags: tags ?? null,
            ftsOnly,
            expandChars,
            withContent,
            globalLimit,
          },
          ...compactPayload,
        }
      : compactPayload;
    const agentResult: CommandResult = {
      _tag: "searchPack",
      queries,
      results: deduped.map((result) => ({
        title: result.title,
        docId: result.docId,
        chunkId: result.chunkId,
        score: result.score,
      })),
    };

    return { resultPayload, agentResult } satisfies CommandBodyOutput;
  });
}

export function runSearchCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: SearchCommandOptions = {},
) {
  return runCommandWithContext(
    args,
    globals,
    (context) => {
      if (context.command === "search") {
        return runSingleSearch(context, options);
      }
      if (context.command === "search-pack") {
        return runSearchPack(context, options);
      }
      return Effect.fail(
        new CLIError(
          "UNKNOWN_COMMAND",
          `Unknown search command: ${context.command}`,
          { command: context.command },
        ),
      );
    },
    options,
  );
}
