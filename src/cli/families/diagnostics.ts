import { Effect } from "effect";
import type { Layer } from "effect";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import { LibraryStore } from "../../services/LibraryStore.js";
import { runDoctorCommand } from "../commands/doctor.js";
import { runInitCommand } from "../commands/init.js";
import { CLIError, type CliLibrary } from "../runner.js";
import { buildDiagnosticsLayer } from "../runtime.js";
import { runFamilyEffect } from "./shared.js";
import type { FamilyRunner } from "./types.js";

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const layer = await buildDiagnosticsLayer(config);
  const program = Effect.gen(function* () {
    const store = yield* LibraryStore;
    const embedding = yield* EmbeddingProvider;
    const commandGlobals = {
      ...globals,
      library: {
        ...store,
        checkReady: () => embedding.checkHealth(),
      } as CliLibrary,
    };
    if (parsed.args[0] === "doctor" || parsed.args[0] === "check") {
      return yield* runDoctorCommand(
        parsed.args,
        commandGlobals,
        parsed.options,
      );
    }
    if (parsed.args[0] === "init") {
      return yield* runInitCommand(
        parsed.args,
        commandGlobals,
        parsed.options,
      );
    }
    return yield* Effect.fail(
      new CLIError(
        "UNKNOWN_COMMAND",
        `Unknown diagnostics command: ${parsed.args[0]}`,
      ),
    );
  });
  return runFamilyEffect(
    program,
    globals,
    layer as unknown as Layer.Layer<unknown, unknown, never>,
  );
};
