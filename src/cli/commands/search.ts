import { Effect } from "effect";
import { SearchOptions } from "../../index.js";
import { type SearchResult } from "../../types.js";
import { type Concept, TaxonomyService } from "../../services/TaxonomyService.js";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import { CLIError, runCommandWithContext, splitPositionalsAndFlags, type GlobalCLIOptions } from "../runner.js";

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

export function runSearchCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: SearchCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, format, library }) =>
    Effect.gen(function* () {
      let resultPayload: unknown = null;
      let agentResult: any = null;
      const command = args[0];
      switch (command) {
		    case "search": {
		      const query = args[1];
		      if (!query) {
		        yield* Console.error("Error: Query required");
		        return yield* Effect.fail(
		          new CLIError("INVALID_ARGS", "Query required", { command: "search" })
		        );
		      }

      const opts = options;
      const limit = opts.limit ? parseInt(String(opts.limit), 10) : 10;
      const tags = opts.tag ? [opts.tag as string] : undefined;
      const ftsOnly = opts.fts === true;
      const expandChars = opts.expand
        ? Math.min(4000, Math.max(0, parseInt(String(opts.expand), 10)))
        : 0;
      const conceptsOnly = opts["concepts-only"] === true || opts.conceptsOnly === true;
      const docsOnly = opts["docs-only"] === true || opts.docsOnly === true;
      const includeClusters = opts["include-clusters"] === true || opts.includeClusters === true;

      // Determine what to search
      const searchDocs = !conceptsOnly;
      const searchConcepts = !docsOnly;

      const modeLabel = conceptsOnly
        ? " (concepts only)"
        : docsOnly
        ? " (docs only)"
        : "";

	      // Track results for agent hints
	      let hintDocResults: { title: string; docId: string; chunkId?: string; score: number }[] = [];
	      let hintConceptResults: { id: string; prefLabel: string }[] = [];
	      let docResults: any[] = [];
	      let conceptResults: Concept[] = [];

      yield* Console.log(
        `Searching: "${query}"${ftsOnly ? " (FTS only)" : ""}${modeLabel}${
          expandChars > 0 ? ` (expand: ${expandChars} chars)` : ""
        }\n`
      );

	      // Search concepts first (if enabled)
	      if (searchConcepts) {
	        const taxonomy = yield* TaxonomyService;
	        const embedProvider = yield* EmbeddingProvider;

	        // Try vector search on concepts using EmbeddingProvider
	        const foundConcepts = yield* Effect.gen(function* () {
	          const healthCheck = yield* Effect.either(embedProvider.checkHealth());
	          if (healthCheck._tag === "Right") {
	            const queryEmbedding = yield* embedProvider.embed(query);
	            const similar = yield* taxonomy.findSimilarConcepts(
	              queryEmbedding,
	              0.3, // Lower threshold for broader results
	              limit
	            );
	            return similar;
	          }
	          // Fallback to text search on concepts if Ollama unavailable
	          const allConcepts = yield* taxonomy.listConcepts();
	          const queryLower = query.toLowerCase();
	          return allConcepts
	            .filter(
	              (c) =>
	                c.prefLabel.toLowerCase().includes(queryLower) ||
	                c.altLabels.some((alt) =>
	                  alt.toLowerCase().includes(queryLower)
	                ) ||
	                (c.definition &&
	                  c.definition.toLowerCase().includes(queryLower))
	            )
	            .slice(0, limit);
	        }).pipe(Effect.catchAll(() => Effect.succeed([] as Concept[])));

	        conceptResults = foundConcepts;
	        hintConceptResults = foundConcepts.map((c) => ({ id: c.id, prefLabel: c.prefLabel }));

	        if (foundConcepts.length > 0) {
	          yield* Console.log(`Concepts (${foundConcepts.length}):\n`);
	          for (const c of foundConcepts) {
	            yield* Console.log(`- ${c.prefLabel} (${c.id})`);
	            if (c.definition) {
	              yield* Console.log(
	                `    ${c.definition.slice(0, 150).replace(/\n/g, " ")}${
	                  c.definition.length > 150 ? "..." : ""
	                }`
	              );
	            }
	            yield* Console.log("");
	          }
	        }
	      }

	      // Search documents (if enabled)
	      if (searchDocs) {
	        const results = ftsOnly
	          ? yield* library.ftsSearch(query, new SearchOptions({ limit, tags }))
	          : yield* library.search(
	              query,
	              new SearchOptions({
	                limit,
	                tags,
	                hybrid: true,
	                expandChars,
	                includeClusterSummaries: includeClusters,
	              })
	            );
	        docResults = results;

	        hintDocResults = results.map((r) => ({
	          title: r.title,
	          docId: r.docId,
	          chunkId: r.chunkId,
	          score: r.score,
	        }));

        if (results.length > 0) {
          if (searchConcepts) {
            yield* Console.log(`Documents (${results.length}):\n`);
          }
          for (const r of results) {
            yield* Console.log(
              `[${r.score.toFixed(3)}|${r.matchType}] ${r.title} (p.${r.page}) [chunk:${r.chunkId}]`
            );

            if (r.expandedContent) {
              // Show expanded content (always available now, larger with --expand)
              const content = r.expandedContent.replace(/\n/g, "\n  ");
              if (expandChars > 0) {
                yield* Console.log(`  ${content}`);
              } else {
                // Default: show first 500 chars of expanded content
                const truncated = content.length > 500
                  ? content.slice(0, 500) + "..."
                  : content;
                yield* Console.log(`  ${truncated}`);
              }
            } else {
              yield* Console.log(
                `  ${r.content.slice(0, 200).replace(/\n/g, " ")}...`
              );
            }
            yield* Console.log("");
          }
        } else if (!searchConcepts) {
          yield* Console.log("No results found");
        }
      }

	      // Build agent result for hints
	      resultPayload = {
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
	        concepts: conceptResults,
	        documents: docResults,
	      };

	      agentResult = {
	        _tag: "search",
	        query,
	        results: hintDocResults,
	        concepts: hintConceptResults,
        hadExpand: expandChars > 0,
        wasFts: ftsOnly,
		      };
		      break;
		    }

        case "search-pack": {
          const { positionals: maybeQueries, flagArgs } = splitPositionalsAndFlags(
            args.slice(1)
          );

          const opts = options;
          const limit = opts.limit ? parseInt(String(opts.limit), 10) : 10;
          const tags = opts.tag ? [String(opts.tag)] : undefined;
          const ftsOnly = opts.fts === true;
          const expandChars = opts.expand
            ? Math.min(4000, Math.max(0, parseInt(String(opts.expand), 10)))
            : 0;
          const withContent = opts["with-content"] === true || opts.withContent === true;
          const globalLimitRaw = opts["global-limit"] ?? opts.globalLimit;
          const globalLimit =
            globalLimitRaw !== undefined
              ? Math.max(1, parseInt(String(globalLimitRaw), 10))
              : null;

          let queries = maybeQueries;

          // If no queries were provided as args, read queries from stdin (one per line).
          if (queries.length === 0) {
            if (process.stdin.isTTY) {
              return yield* Effect.fail(
                new CLIError(
                  "INVALID_ARGS",
                  "search-pack requires queries as args or via stdin",
                  {
                    command: "search-pack",
                    hint: 'poink search-pack "query one" "query two"',
                  }
                )
              );
            }

            const stdinText = yield* Effect.tryPromise({
              try: () =>
                new Promise<string>((resolve, reject) => {
                  let data = "";
                  try {
                    process.stdin.setEncoding("utf8");
                  } catch {
                    // ignore
                  }
                  process.stdin.on("data", (chunk) => {
                    data += String(chunk);
                  });
                  process.stdin.on("end", () => resolve(data));
                  process.stdin.on("error", (err) => reject(err));
                }),
              catch: (e) =>
                new CLIError("IO_ERROR", "Failed to read stdin", {
                  reason: String(e),
                }),
            });

            queries = stdinText
              .split(/\r?\n/g)
              .map((l) => l.trim())
              .filter((l) => l.length > 0 && !l.startsWith("#"));
          }

          if (queries.length === 0) {
            return yield* Effect.fail(
              new CLIError("INVALID_ARGS", "No queries provided", {
                command: "search-pack",
              })
            );
          }

          type ChunkHandle = {
            chunkId: string;
            docId: string;
            title: string;
            page: number;
            chunkIndex: number;
            score: number;
            rawScore: number;
            scoreType: string;
            matchType: string;
            vectorScore?: number;
            ftsRank?: number;
            // Optional payload for verbose workflows
            content?: string;
            expandedContent?: string;
          };

          const toHandle = (r: SearchResult): ChunkHandle => ({
            chunkId: r.chunkId,
            docId: r.docId,
            title: r.title,
            page: r.page,
            chunkIndex: r.chunkIndex,
            score: r.score,
            rawScore: r.rawScore,
            scoreType: r.scoreType,
            matchType: r.matchType,
            vectorScore: r.vectorScore,
            ftsRank: r.ftsRank,
            ...(withContent
              ? { content: r.content, expandedContent: r.expandedContent }
              : {}),
          });

          const perQuery: Array<{ query: string; documents: ChunkHandle[] }> = [];
          const merged = new Map<
            string,
            { best: ChunkHandle; matchedQueries: Set<string> }
          >();

          for (const query of queries) {
            const results = ftsOnly
              ? yield* library.ftsSearch(
                  query,
                  new SearchOptions({ limit, tags })
                )
              : yield* library.search(
                  query,
                  new SearchOptions({
                    limit,
                    tags,
                    hybrid: true,
                    expandChars,
                  })
                );

            const handles = results.map(toHandle);
            perQuery.push({ query, documents: handles });

            for (const h of handles) {
              const existing = merged.get(h.chunkId);
              if (!existing) {
                merged.set(h.chunkId, { best: h, matchedQueries: new Set([query]) });
                continue;
              }
              existing.matchedQueries.add(query);
              if (h.score > existing.best.score) {
                existing.best = h;
              }
            }
          }

          let deduped = Array.from(merged.values()).map(({ best, matchedQueries }) => ({
            ...best,
            matchedQueries: Array.from(matchedQueries).sort(),
          }));

          deduped.sort((a, b) => b.score - a.score);
          if (typeof globalLimit === "number" && !Number.isNaN(globalLimit)) {
            deduped = deduped.slice(0, globalLimit);
          }

          resultPayload = {
            queries,
            options: {
              limit,
              tags: tags ?? null,
              ftsOnly,
              expandChars,
              withContent,
              globalLimit,
            },
            perQuery,
            deduped,
          };

          agentResult = {
            _tag: "searchPack",
            queries,
            results: deduped.map((r) => ({
              title: r.title,
              docId: r.docId,
              chunkId: r.chunkId,
              score: r.score,
            })),
          };
          break;
        }

        default:
          return yield* Effect.fail(new CLIError("UNKNOWN_COMMAND", `Unknown search command: ${command}`, { command }));
      }
      return { resultPayload, agentResult };
    }),
    options);
}
