import { Effect } from "effect";
import { TaxonomyService, type Concept } from "../../services/TaxonomyService.js";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import { buildTreeStructure, CLIError, renderConceptTree, runCommandWithContext, type GlobalCLIOptions } from "../runner.js";

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

type CompactTreeNode = {
  id: string;
  prefLabel: string;
  children: CompactTreeNode[];
};

type PublicConcept = {
  id: string;
  prefLabel: string;
  altLabels: string[];
  definition?: string;
};

type VerboseTreeNode = {
  concept: PublicConcept;
  children: VerboseTreeNode[];
};

type TaxonomyTreeNode = {
  concept: Concept;
  children: TaxonomyTreeNode[];
};

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

export function runTaxonomyCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: TaxonomyCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, format, globals }) =>
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
          "Usage: poink taxonomy <list|tree|get|search|add> [args]"
        );
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", "taxonomy subcommand required", {
            available: ["list", "tree", "get", "search", "add"],
          })
        );
      }

      if (subcommand === "list") {
        const concepts = yield* taxonomy.listConcepts();
        resultPayload = {
          concepts: globals.verbose
            ? concepts.map(publicConcept)
            : concepts.map(summarizeConcept),
        };

        if (format === "text") {
          yield* Console.log(`Concepts: ${concepts.length}\n`);
          for (const c of concepts) {
            yield* Console.log(`- ${c.prefLabel} (${c.id})`);
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

        resultPayload = {
          rootId: rootId ?? null,
          tree: globals.verbose
            ? roots.map(verboseTree)
            : roots.map(compactTree),
        };

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

      if (subcommand === "get") {
        const id = args[2];
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

        resultPayload = {
          ...publicConcept(concept),
          broader: broader.map(summarizeConcept),
          narrower: narrower.map(summarizeConcept),
          related: related.map(summarizeConcept),
        };

        if (format === "text") {
          yield* Console.log(`Label: ${concept.prefLabel}`);
          yield* Console.log(`ID: ${concept.id}`);
          if (concept.altLabels.length > 0) {
            yield* Console.log(`Alternative labels: ${concept.altLabels.join(", ")}`);
          }
          if (concept.definition) {
            yield* Console.log(`Definition: ${concept.definition}`);
          }
          if (broader.length > 0) {
            yield* Console.log(
              `Broader: ${broader.map((item) => `${item.prefLabel} (${item.id})`).join(", ")}`,
            );
          }
          if (narrower.length > 0) {
            yield* Console.log(
              `Narrower: ${narrower.map((item) => `${item.prefLabel} (${item.id})`).join(", ")}`,
            );
          }
          if (related.length > 0) {
            yield* Console.log(
              `Related: ${related.map((item) => `${item.prefLabel} (${item.id})`).join(", ")}`,
            );
          }
        }

        agentResult = {
          _tag: "taxonomyTree",
          rootId: concept.id,
        };
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

        const publicMatches = matches.map((concept) => ({
          id: concept.id,
          prefLabel: concept.prefLabel,
          ...(concept.definition ? { definition: concept.definition } : {}),
          ...(globals.verbose ? { altLabels: [...concept.altLabels] } : {}),
        }));
        resultPayload = globals.verbose
          ? { query, mode, limit, threshold, matches: publicMatches }
          : { matches: publicMatches };

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
          { subcommand, available: ["list", "tree", "get", "search", "add"] }
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
