import { Effect } from "effect";
import { TaxonomyService, type Concept } from "../../services/TaxonomyService.js";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import { buildTreeStructure, CLIError, renderConceptTree, runCommandWithContext, type GlobalCLIOptions } from "../runner.js";

interface TaxonomyCommandOptions extends Record<string, unknown> {
  tree?: boolean;
  limit?: string | number;
  threshold?: string | number;
  label?: string;
  broader?: string;
  definition?: string;
  "alt-labels"?: string;
  altLabels?: string;
}

export function runTaxonomyCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: TaxonomyCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, format }) =>
    Effect.gen(function* () {
      let resultPayload: unknown = null;
      let agentResult: any = null;
      const command = args[0];
      switch (command) {
    case "taxonomy": {
      const subcommand = args[1];
      const taxonomy = yield* TaxonomyService;

      if (!subcommand) {
        yield* Console.error("Error: taxonomy subcommand required");
        yield* Console.error(
          "Usage: poink taxonomy <list|tree|search|add> [args]"
        );
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", "taxonomy subcommand required", {
            available: ["list", "tree", "search", "add"],
          })
        );
      }

      if (subcommand === "list") {
        const opts = options;
        const includeTree = opts.tree === true;

        const concepts = yield* taxonomy.listConcepts();

        if (includeTree) {
          const roots = yield* Effect.promise(() => buildTreeStructure(taxonomy));
          resultPayload = { concepts, tree: roots };

          if (format === "text") {
            yield* Console.log(`Concepts: ${concepts.length}\n`);
            for (const root of roots) {
              for (const line of renderConceptTree(root)) {
                yield* Console.log(line);
              }
              yield* Console.log("");
            }
          }
        } else {
          resultPayload = { concepts };

          if (format === "text") {
            yield* Console.log(`Concepts: ${concepts.length}\n`);
            for (const c of concepts) {
              yield* Console.log(`- ${c.prefLabel} (${c.id})`);
            }
          }
        }

        agentResult = { _tag: "taxonomyList", count: concepts.length };
        break;
      }

      if (subcommand === "tree") {
        const rootId = args[2];
        const roots = yield* Effect.promise(() =>
          buildTreeStructure(taxonomy, rootId)
        );

        if (rootId && roots.length === 0) {
          yield* Console.error(`Concept not found: ${rootId}`);
          return yield* Effect.fail(
            new CLIError("NOT_FOUND", `Concept not found: ${rootId}`, {
              rootId,
            })
          );
        }

        resultPayload = { rootId: rootId ?? null, tree: roots };

        if (format === "text") {
          for (const root of roots) {
            for (const line of renderConceptTree(root)) {
              yield* Console.log(line);
            }
            yield* Console.log("");
          }
        }

        agentResult = { _tag: "taxonomyTree", rootId: rootId ?? undefined };
        break;
      }

      if (subcommand === "search") {
        const query = args[2];
        if (!query) {
          yield* Console.error("Error: query required");
          yield* Console.error("Usage: poink taxonomy search <query>");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "query required", {
              command: "taxonomy search",
            })
          );
        }

        const opts = options;
        const limit = opts.limit ? parseInt(String(opts.limit), 10) : 10;
        const threshold = opts.threshold
          ? parseFloat(String(opts.threshold))
          : 0.3;

        const embedProvider = yield* EmbeddingProvider;

        let mode: "vector" | "text" = "text";
        let matches: Concept[] = [];

        const healthCheck = yield* Effect.either(embedProvider.checkHealth());
        if (healthCheck._tag === "Right") {
          mode = "vector";
          const queryEmbedding = yield* embedProvider.embed(query);
          matches = yield* taxonomy.findSimilarConcepts(
            queryEmbedding,
            threshold,
            limit
          );
        } else {
          mode = "text";
          const all = yield* taxonomy.listConcepts();
          const q = query.toLowerCase();
          matches = all
            .filter(
              (c) =>
                c.prefLabel.toLowerCase().includes(q) ||
                c.altLabels.some((alt) => alt.toLowerCase().includes(q)) ||
                (c.definition && c.definition.toLowerCase().includes(q))
            )
            .slice(0, limit);
        }

        resultPayload = { query, mode, limit, threshold, matches };

        if (format === "text") {
          yield* Console.log(`Matches: ${matches.length}\n`);
          for (const c of matches) {
            yield* Console.log(`- ${c.prefLabel} (${c.id})`);
            if (c.definition) {
              yield* Console.log(
                `  ${c.definition.slice(0, 160).replace(/\n/g, " ")}${
                  c.definition.length > 160 ? "..." : ""
                }`
              );
            }
          }
        }

        agentResult = {
          _tag: "taxonomySearch",
          query,
          matches: matches.map((c) => ({ id: c.id, prefLabel: c.prefLabel })),
        };
        break;
      }

      if (subcommand === "add") {
        const id = args[2];
        if (!id) {
          yield* Console.error("Error: concept id required");
          yield* Console.error(
            "Usage: poink taxonomy add <id> --label \"<name>\" [--broader <parent>]"
          );
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "concept id required", {
              command: "taxonomy add",
            })
          );
        }

        const opts = options;
        const labelRaw = opts.label;
        const label = typeof labelRaw === "string" ? labelRaw : undefined;
        const broaderRaw = opts.broader;
        const broader = typeof broaderRaw === "string" ? broaderRaw : undefined;
        const definitionRaw = opts.definition;
        const definition =
          typeof definitionRaw === "string" ? definitionRaw : undefined;
        const altLabelsRaw = opts["alt-labels"] ?? opts.altLabels;
        const altLabels =
          typeof altLabelsRaw === "string"
            ? altLabelsRaw.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined;

        if (!label) {
          yield* Console.error("Error: --label required");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "--label required", {
              command: "taxonomy add",
              hint: "poink taxonomy add my/concept --label \"My Concept\"",
            })
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

        // Best-effort: store concept embedding so it becomes searchable via vectors.
        const embedProvider = yield* EmbeddingProvider;
        const healthCheck = yield* Effect.either(embedProvider.checkHealth());
        const storedEmbedding = healthCheck._tag === "Right";
        if (storedEmbedding) {
          const embedding = yield* embedProvider.embed(label);
          yield* taxonomy.storeConceptEmbedding(id, embedding);
        }

        resultPayload = {
          id,
          prefLabel: label,
          broader: broader ?? null,
          storedEmbedding,
        };

        if (format === "text") {
          yield* Console.log(`OK Added concept: ${label} (${id})`);
          if (broader) yield* Console.log(`  broader: ${broader}`);
        }

        agentResult = { _tag: "taxonomyTree", rootId: id };
        break;
      }

      yield* Console.error(`Unknown taxonomy subcommand: ${subcommand}`);
      return yield* Effect.fail(
        new CLIError(
          "INVALID_ARGS",
          `Unknown taxonomy subcommand: ${subcommand}`,
          { subcommand, available: ["list", "tree", "search", "add"] }
        )
      );
    }

        default:
          return yield* Effect.fail(new CLIError("UNKNOWN_COMMAND", `Unknown taxonomy command: ${command}`, { command }));
      }
      return { resultPayload, agentResult };
    }),
    options);
}
