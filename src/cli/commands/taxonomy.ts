import { Effect } from "effect";
import type { CommandResult } from "../../agent/hints.js";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import {
  TaxonomyService,
  type Concept,
  type TaxonomyService as TaxonomyServiceApi,
} from "../../services/TaxonomyService.js";
import {
  buildTreeStructure,
  CLIError,
  renderConceptTree,
  runCommandWithContext,
  type CommandBodyOutput,
  type CommandExecutionContext,
  type GlobalCLIOptions,
} from "../runner.js";

interface TaxonomyCommandOptions extends Record<string, unknown> {
  limit?: string | number;
  threshold?: string | number;
  label?: string;
  broader?: string;
  definition?: string;
  "alt-labels"?: string;
  altLabels?: string;
}

type ConceptSummary = Pick<Concept, "id" | "prefLabel">;

type PublicConcept = {
  id: string;
  prefLabel: string;
  altLabels: string[];
  definition?: string;
};

type TaxonomyTreeNode = {
  concept: Concept;
  children: TaxonomyTreeNode[];
};

type CompactTreeNode = {
  id: string;
  prefLabel: string;
  children: CompactTreeNode[];
};

type VerboseTreeNode = {
  concept: PublicConcept;
  children: VerboseTreeNode[];
};

type AddConceptOptions = {
  label?: string;
  broader?: string;
  definition?: string;
  altLabels?: string[];
};

const TAXONOMY_SUBCOMMANDS = ["list", "tree", "get", "search", "add"];
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEARCH_THRESHOLD = 0.3;
const DEFINITION_PREVIEW_LENGTH = 160;

function commandOutput(
  resultPayload: unknown,
  agentResult: CommandResult,
): CommandBodyOutput {
  return { resultPayload, agentResult };
}

function summarizeConcept(concept: Concept): ConceptSummary {
  return { id: concept.id, prefLabel: concept.prefLabel };
}

function publicConcept(concept: Concept): PublicConcept {
  return {
    id: concept.id,
    prefLabel: concept.prefLabel,
    altLabels: [...concept.altLabels],
    ...(concept.definition ? { definition: concept.definition } : {}),
  };
}

function compactTree(node: TaxonomyTreeNode): CompactTreeNode {
  return {
    id: node.concept.id,
    prefLabel: node.concept.prefLabel,
    children: node.children.map(compactTree),
  };
}

function verboseTree(node: TaxonomyTreeNode): VerboseTreeNode {
  return {
    concept: publicConcept(node.concept),
    children: node.children.map(verboseTree),
  };
}

function parseNumberOption(
  value: string | number | undefined,
  fallback: number,
  parser: (value: string) => number,
): number {
  return value ? parser(String(value)) : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseAddConceptOptions(
  options: TaxonomyCommandOptions,
): AddConceptOptions {
  const altLabelsRaw = options["alt-labels"] ?? options.altLabels;

  return {
    label: optionalString(options.label),
    broader: optionalString(options.broader),
    definition: optionalString(options.definition),
    altLabels:
      typeof altLabelsRaw === "string"
        ? altLabelsRaw
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean)
        : undefined,
  };
}

function matchesQuery(concept: Concept, query: string): boolean {
  return (
    concept.prefLabel.toLowerCase().includes(query) ||
    concept.altLabels.some((label) => label.toLowerCase().includes(query)) ||
    concept.definition?.toLowerCase().includes(query) === true
  );
}

function renderConceptList(
  Console: CommandExecutionContext["Console"],
  concepts: Concept[],
) {
  return Effect.gen(function* () {
    yield* Console.log(`Concepts: ${concepts.length}\n`);
    for (const concept of concepts) {
      yield* Console.log(`- ${concept.prefLabel} (${concept.id})`);
    }
  });
}

function renderConceptDetails(
  Console: CommandExecutionContext["Console"],
  concept: Concept,
  broader: Concept[],
  narrower: Concept[],
  related: Concept[],
) {
  return Effect.gen(function* () {
    yield* Console.log(`Label: ${concept.prefLabel}`);
    yield* Console.log(`ID: ${concept.id}`);

    if (concept.altLabels.length > 0) {
      yield* Console.log(
        `Alternative labels: ${concept.altLabels.join(", ")}`,
      );
    }
    if (concept.definition) {
      yield* Console.log(`Definition: ${concept.definition}`);
    }

    for (const [label, concepts] of [
      ["Broader", broader],
      ["Narrower", narrower],
      ["Related", related],
    ] as const) {
      if (concepts.length > 0) {
        const summaries = concepts
          .map((item) => `${item.prefLabel} (${item.id})`)
          .join(", ");
        yield* Console.log(`${label}: ${summaries}`);
      }
    }
  });
}

function renderSearchResults(
  Console: CommandExecutionContext["Console"],
  matches: Concept[],
) {
  return Effect.gen(function* () {
    yield* Console.log(`Matches: ${matches.length}\n`);
    for (const concept of matches) {
      yield* Console.log(`- ${concept.prefLabel} (${concept.id})`);
      if (concept.definition) {
        const preview = concept.definition
          .slice(0, DEFINITION_PREVIEW_LENGTH)
          .replace(/\n/g, " ");
        const suffix =
          concept.definition.length > DEFINITION_PREVIEW_LENGTH ? "..." : "";
        yield* Console.log(`  ${preview}${suffix}`);
      }
    }
  });
}

function findMatches(
  taxonomy: TaxonomyServiceApi,
  query: string,
  threshold: number,
  limit: number,
) {
  return Effect.gen(function* () {
    const embedProvider = yield* EmbeddingProvider;
    const healthCheck = yield* Effect.either(embedProvider.checkHealth());

    if (healthCheck._tag === "Right") {
      const queryEmbedding = yield* embedProvider.embed(query);
      const matches = yield* taxonomy.findSimilarConcepts(
        queryEmbedding,
        threshold,
        limit,
      );
      return { mode: "vector" as const, matches };
    }

    const normalizedQuery = query.toLowerCase();
    const concepts = yield* taxonomy.listConcepts();
    return {
      mode: "text" as const,
      matches: concepts
        .filter((concept) => matchesQuery(concept, normalizedQuery))
        .slice(0, limit),
    };
  });
}

function storeEmbeddingIfAvailable(
  taxonomy: TaxonomyServiceApi,
  id: string,
  label: string,
) {
  return Effect.gen(function* () {
    const embedProvider = yield* EmbeddingProvider;
    const healthCheck = yield* Effect.either(embedProvider.checkHealth());

    if (healthCheck._tag === "Left") {
      return false;
    }

    const embedding = yield* embedProvider.embed(label);
    yield* taxonomy.storeConceptEmbedding(id, embedding);
    return true;
  });
}

function runList(
  context: CommandExecutionContext,
  taxonomy: TaxonomyServiceApi,
) {
  return Effect.gen(function* () {
    const concepts = yield* taxonomy.listConcepts();

    if (context.format === "text") {
      yield* renderConceptList(context.Console, concepts);
    }

    return commandOutput(
      {
        concepts: context.globals.verbose
          ? concepts.map(publicConcept)
          : concepts.map(summarizeConcept),
      },
      { _tag: "taxonomyList", count: concepts.length },
    );
  });
}

function runTree(
  context: CommandExecutionContext,
  taxonomy: TaxonomyServiceApi,
) {
  return Effect.gen(function* () {
    const rootId = context.args[2];
    const roots = yield* Effect.promise(() =>
      buildTreeStructure(taxonomy, rootId),
    );

    if (rootId && roots.length === 0) {
      yield* context.Console.error(`Concept not found: ${rootId}`);
      return yield* Effect.fail(
        new CLIError("NOT_FOUND", `Concept not found: ${rootId}`, { rootId }),
      );
    }

    if (context.format === "text") {
      for (const root of roots) {
        for (const line of renderConceptTree(root)) {
          yield* context.Console.log(line);
        }
        yield* context.Console.log("");
      }
    }

    return commandOutput(
      {
        rootId: rootId ?? null,
        tree: context.globals.verbose
          ? roots.map(verboseTree)
          : roots.map(compactTree),
      },
      { _tag: "taxonomyTree", rootId: rootId ?? undefined },
    );
  });
}

function runGet(
  context: CommandExecutionContext,
  taxonomy: TaxonomyServiceApi,
) {
  return Effect.gen(function* () {
    const id = context.args[2];
    if (!id) {
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", "Concept id required", {
          command: "taxonomy get",
        }),
      );
    }

    const concept = yield* taxonomy.getConcept(id);
    if (!concept) {
      return yield* Effect.fail(
        new CLIError("NOT_FOUND", `Concept not found: ${id}`, { id }),
      );
    }

    const [broader, narrower, related] = yield* Effect.all([
      taxonomy.getBroader(id),
      taxonomy.getNarrower(id),
      taxonomy.getRelated(id),
    ]);

    if (context.format === "text") {
      yield* renderConceptDetails(
        context.Console,
        concept,
        broader,
        narrower,
        related,
      );
    }

    return commandOutput(
      {
        ...publicConcept(concept),
        broader: broader.map(summarizeConcept),
        narrower: narrower.map(summarizeConcept),
        related: related.map(summarizeConcept),
      },
      { _tag: "taxonomyTree", rootId: concept.id },
    );
  });
}

function runSearch(
  context: CommandExecutionContext,
  taxonomy: TaxonomyServiceApi,
  options: TaxonomyCommandOptions,
) {
  return Effect.gen(function* () {
    const query = context.args[2];
    if (!query) {
      yield* context.Console.error("Error: query required");
      yield* context.Console.error("Usage: poink taxonomy search <query>");
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", "query required", {
          command: "taxonomy search",
        }),
      );
    }

    const limit = parseNumberOption(
      options.limit,
      DEFAULT_SEARCH_LIMIT,
      (value) => Number.parseInt(value, 10),
    );
    const threshold = parseNumberOption(
      options.threshold,
      DEFAULT_SEARCH_THRESHOLD,
      Number.parseFloat,
    );
    const { mode, matches } = yield* findMatches(
      taxonomy,
      query,
      threshold,
      limit,
    );

    if (context.format === "text") {
      yield* renderSearchResults(context.Console, matches);
    }

    const publicMatches = matches.map((concept) => ({
      id: concept.id,
      prefLabel: concept.prefLabel,
      ...(concept.definition ? { definition: concept.definition } : {}),
      ...(context.globals.verbose
        ? { altLabels: [...concept.altLabels] }
        : {}),
    }));
    const resultPayload =
      context.globals.verbose
        ? { query, mode, limit, threshold, matches: publicMatches }
        : { matches: publicMatches };

    return commandOutput(resultPayload, {
      _tag: "taxonomySearch",
      query,
      matches: matches.map(summarizeConcept),
    });
  });
}

function runAdd(
  context: CommandExecutionContext,
  taxonomy: TaxonomyServiceApi,
  options: TaxonomyCommandOptions,
) {
  return Effect.gen(function* () {
    const id = context.args[2];
    if (!id) {
      yield* context.Console.error("Error: concept id required");
      yield* context.Console.error(
        'Usage: poink taxonomy add <id> --label "<name>" [--broader <parent>]',
      );
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", "concept id required", {
          command: "taxonomy add",
        }),
      );
    }

    const { label, broader, definition, altLabels } =
      parseAddConceptOptions(options);
    if (!label) {
      yield* context.Console.error("Error: --label required");
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", "--label required", {
          command: "taxonomy add",
          hint: 'poink taxonomy add my/concept --label "My Concept"',
        }),
      );
    }

    yield* taxonomy.addConcept({
      id,
      prefLabel: label,
      altLabels,
      definition,
    });

    if (broader) {
      yield* taxonomy.addBroader(id, broader);
    }

    const storedEmbedding = yield* storeEmbeddingIfAvailable(
      taxonomy,
      id,
      label,
    );

    if (context.format === "text") {
      yield* context.Console.log(`OK Added concept: ${label} (${id})`);
      if (broader) {
        yield* context.Console.log(`  broader: ${broader}`);
      }
    }

    return commandOutput(
      {
        id,
        prefLabel: label,
        broader: broader ?? null,
        storedEmbedding,
      },
      { _tag: "taxonomyTree", rootId: id },
    );
  });
}

function runTaxonomySubcommand(
  context: CommandExecutionContext,
  options: TaxonomyCommandOptions,
) {
  return Effect.gen(function* () {
    if (context.command !== "taxonomy") {
      return yield* Effect.fail(
        new CLIError(
          "UNKNOWN_COMMAND",
          `Unknown taxonomy command: ${context.command}`,
          { command: context.command },
        ),
      );
    }

    const subcommand = context.args[1];
    const taxonomy = yield* TaxonomyService;

    if (!subcommand) {
      yield* context.Console.error("Error: taxonomy subcommand required");
      yield* context.Console.error(
        "Usage: poink taxonomy <list|tree|get|search|add> [args]",
      );
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", "taxonomy subcommand required", {
          available: TAXONOMY_SUBCOMMANDS,
        }),
      );
    }

    if (subcommand === "list") {
      return yield* runList(context, taxonomy);
    }
    if (subcommand === "tree") {
      return yield* runTree(context, taxonomy);
    }
    if (subcommand === "get") {
      return yield* runGet(context, taxonomy);
    }
    if (subcommand === "search") {
      return yield* runSearch(context, taxonomy, options);
    }
    if (subcommand === "add") {
      return yield* runAdd(context, taxonomy, options);
    }

    yield* context.Console.error(`Unknown taxonomy subcommand: ${subcommand}`);
    return yield* Effect.fail(
      new CLIError(
        "INVALID_ARGS",
        `Unknown taxonomy subcommand: ${subcommand}`,
        { subcommand, available: TAXONOMY_SUBCOMMANDS },
      ),
    );
  });
}

export function runTaxonomyCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: TaxonomyCommandOptions = {},
) {
  return runCommandWithContext(
    args,
    globals,
    (context) => runTaxonomySubcommand(context, options),
    options,
  );
}
