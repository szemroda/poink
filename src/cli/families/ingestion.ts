import { Effect } from "effect";
import { DocumentIngestion } from "../../services/DocumentIngestion.js";
import { LibraryStore } from "../../services/LibraryStore.js";
import { SemanticLibrary } from "../../services/SemanticLibrary.js";
import { runAddCommand } from "../commands/add.js";
import { runIngestCommand } from "../commands/ingest.js";
import { runRechunkCommand } from "../commands/rechunk.js";
import { runReindexCommand } from "../commands/reindex.js";
import {
  CLIError,
  type GlobalCLIOptions,
} from "../runner.js";
import { buildIngestionLayer } from "../runtime.js";
import { runFamilyEffect } from "./shared.js";
import type { FamilyRunner } from "./types.js";

type IngestionCommandHandler = (
  args: string[],
  globals: GlobalCLIOptions,
  options: Record<string, unknown>,
) => Effect.Effect<unknown, unknown, unknown>;

const COMMAND_HANDLERS: Readonly<Record<string, IngestionCommandHandler>> = {
  add: runAddCommand,
  ingest: runIngestCommand,
  rechunk: runRechunkCommand,
  reindex: runReindexCommand,
};

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
      library: { ...store, ...semantic, ...ingestion },
    };
    const command = parsed.args[0];
    const handler = command ? COMMAND_HANDLERS[command] : undefined;
    if (!handler) {
      return yield* Effect.fail(
        new CLIError(
          "UNKNOWN_COMMAND",
          `Unknown ingestion command: ${command}`,
        ),
      );
    }

    return yield* handler(parsed.args, commandGlobals, parsed.options);
  });

  const providedProgram = program.pipe(
    Effect.provide(layer),
    Effect.scoped,
  );

  return runFamilyEffect(providedProgram, globals);
};
