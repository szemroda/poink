import { Effect } from "effect";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { LibraryConfig } from "../../types.js";
import {
  TaxonomyService,
  type TaxonomyJSON,
} from "../../services/TaxonomyService.js";
import {
  runCommandWithContext,
  type CliLibrary,
  type GlobalCLIOptions,
} from "../runner.js";
import type { CliConsole } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface InitCommandOptions extends Record<string, unknown> {}

export function initializePoinkLibrary(
  Console: CliConsole,
  library: CliLibrary,
  config: LibraryConfig,
) {
  return Effect.gen(function* () {
    yield* Console.log("Initializing poink...\n");

    if (!existsSync(config.libraryPath)) {
      mkdirSync(config.libraryPath, { recursive: true });
      yield* Console.log(`OK Created library directory: ${config.libraryPath}`);
    } else {
      yield* Console.log(`OK Library directory exists: ${config.libraryPath}`);
    }

    yield* Console.log("OK Database initialized");

    const ollamaResult = yield* Effect.either(library.checkReady());
    if (ollamaResult._tag === "Right") {
      yield* Console.log("OK Ollama is ready");
    } else {
      yield* Console.log(
        "WARN Ollama not available - run 'ollama serve' and pull models:",
      );
      yield* Console.log("    ollama pull mxbai-embed-large");
      yield* Console.log("    ollama pull llama3.2:3b");
    }

    const taxonomy = yield* TaxonomyService;
    const seedResult = yield* Effect.either(
      Effect.gen(function* () {
        const concepts = yield* taxonomy.listConcepts();

        if (concepts.length === 0) {
          const taxonomyFile = join(__dirname, "..", "..", "data", "taxonomy.json");
          if (existsSync(taxonomyFile)) {
            const taxonomyData = JSON.parse(
              readFileSync(taxonomyFile, "utf-8"),
            ) as TaxonomyJSON;
            yield* taxonomy.seedFromJSON(taxonomyData);
            yield* Console.log(
              `OK Seeded taxonomy with ${taxonomyData.concepts.length} concepts`,
            );
          } else {
            yield* Console.log(
              "WARN No taxonomy.json found - skipping taxonomy seed",
            );
          }
        } else {
          yield* Console.log(
            `OK Taxonomy already has ${concepts.length} concepts`,
          );
        }
      }),
    );

    if (seedResult._tag === "Left") {
      yield* Console.log(
        "WARN Taxonomy seed failed - you can seed manually with 'poink taxonomy seed'",
      );
    }

    const stats = yield* library.stats();
    yield* Console.log("\nLibrary Status:");
    yield* Console.log(`   Documents:  ${stats.documents}`);
    yield* Console.log(`   Chunks:     ${stats.chunks}`);
    yield* Console.log(`   Embeddings: ${stats.embeddings}`);

    yield* Console.log("\nReady! Add documents with:");
    yield* Console.log("   poink add <file.pdf|file.docx|file.odt> --enrich");
    yield* Console.log("   poink ingest <directory> --enrich");

    return {
      libraryPath: config.libraryPath,
      dbPath: config.dbPath,
      ollamaReady: ollamaResult._tag === "Right",
      taxonomySeedOk: seedResult._tag === "Right",
      stats,
    };
  });
}

export function runInitCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: InitCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library, globals }) =>
    Effect.gen(function* () {
      const result = yield* initializePoinkLibrary(
        Console,
        library,
        LibraryConfig.fromConfig(globals.config!),
      );

      return {
        resultPayload: {
          libraryPath: result.libraryPath,
          dbPath: result.dbPath,
          ollamaReady: result.ollamaReady,
          taxonomySeedOk: result.taxonomySeedOk,
          stats: result.stats,
        },
        agentResult: {
          _tag: "stats" as const,
          documents: result.stats.documents,
          chunks: result.stats.chunks,
          embeddings: result.stats.embeddings,
        },
      };
    }),
    options);
}
