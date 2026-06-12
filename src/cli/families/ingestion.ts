import { Effect } from "effect";
import type { Layer } from "effect";
import { DocumentIngestion } from "../../services/DocumentIngestion.js";
import { LibraryStore } from "../../services/LibraryStore.js";
import { SemanticLibrary } from "../../services/SemanticLibrary.js";
import { runAddCommand } from "../commands/add.js";
import { runIngestCommand } from "../commands/ingest.js";
import { runRechunkCommand } from "../commands/rechunk.js";
import { runReindexCommand } from "../commands/reindex.js";
import { CLIError, type CliLibrary } from "../runner.js";
import { buildIngestionLayer } from "../runtime.js";
import { runFamilyEffect } from "./shared.js";
import type { FamilyRunner } from "./types.js";

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const layer = await buildIngestionLayer(config);
  const program = Effect.gen(function* () {
    const store = yield* LibraryStore;
    const semantic = yield* SemanticLibrary;
    const ingestion = yield* DocumentIngestion;
    const commandGlobals = {
      ...globals,
      library: { ...store, ...semantic, ...ingestion } as CliLibrary,
    };
    switch (parsed.args[0]) {
      case "add":
        return yield* runAddCommand(
          parsed.args,
          commandGlobals,
          parsed.options,
        );
      case "ingest":
        return yield* runIngestCommand(
          parsed.args,
          commandGlobals,
          parsed.options,
        );
      case "reindex":
        return yield* runReindexCommand(
          parsed.args,
          commandGlobals,
          parsed.options,
        );
      case "rechunk":
        return yield* runRechunkCommand(
          parsed.args,
          commandGlobals,
          parsed.options,
        );
      default:
        return yield* Effect.fail(
          new CLIError(
            "UNKNOWN_COMMAND",
            `Unknown ingestion command: ${parsed.args[0]}`,
          ),
        );
    }
  });
  return runFamilyEffect(
    program,
    globals,
    layer as unknown as Layer.Layer<unknown, unknown, never>,
  );
};
