import { Effect } from "effect";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import { LibraryStore } from "../../services/LibraryStore.js";
import { DocumentIntegrityRepository } from "../../services/StorageRepositories.js";
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
    const integrity = yield* DocumentIntegrityRepository;
    const command = parsed.args[0];
    const commandGlobals = {
      ...globals,
      library: {
        ...store,
        checkReady: () => embedding.checkHealth(),
        getWithSourceIdentity: integrity.getDocumentWithSourceIdentity,
        listWithSourceIdentity: integrity.listDocumentsWithSourceIdentity,
      } as CliLibrary,
    };

    if (command === "doctor" || command === "check") {
      return yield* runDoctorCommand(
        parsed.args,
        commandGlobals,
        parsed.options,
      );
    }

    if (command === "init") {
      return yield* runInitCommand(
        parsed.args,
        commandGlobals,
        parsed.options,
      );
    }
    return yield* Effect.fail(
      new CLIError(
        "UNKNOWN_COMMAND",
        `Unknown diagnostics command: ${command}`,
      ),
    );
  });
  const providedProgram = program.pipe(
    Effect.provide(layer),
    Effect.scoped,
  );

  return runFamilyEffect(providedProgram, globals);
};
