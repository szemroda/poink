import { Effect } from "effect";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import { LibraryStore } from "../../services/LibraryStore.js";
import { TaxonomyService } from "../../services/TaxonomyService.js";
import { DocumentIntegrityRepository } from "../../services/StorageRepositories.js";
import { runDoctorCommand } from "../commands/doctor.js";
import { runInitCommand } from "../commands/init.js";
import {
  type CommandExecutionOutput,
  type DiagnosticsCliLibrary,
  type GlobalCLIOptionsWithLibrary,
} from "../runner.js";
import { buildDiagnosticsLayer } from "../runtime.js";
import {
  commandHandlers,
  type KnownFamilyError,
  runFamilyEffect,
  runResolvedFamilyCommand,
} from "./shared.js";
import type { FamilyRunner } from "./types.js";

type DiagnosticsCommandError =
  | Effect.Effect.Error<ReturnType<typeof runDoctorCommand>>
  | Effect.Effect.Error<ReturnType<typeof runInitCommand>>;

const COMMAND_HANDLERS = commandHandlers<
  CommandExecutionOutput,
  KnownFamilyError<DiagnosticsCommandError>,
  TaxonomyService,
  GlobalCLIOptionsWithLibrary<DiagnosticsCliLibrary>
>([
  ["doctor", runDoctorCommand],
  ["check", runDoctorCommand],
  ["init", runInitCommand],
]);

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
    const commandGlobals = {
      ...globals,
      library: {
        ...store,
        checkReady: () => embedding.checkHealth(),
        getWithSourceIdentity: integrity.getDocumentWithSourceIdentity,
        listWithSourceIdentity: integrity.listDocumentsWithSourceIdentity,
      } satisfies DiagnosticsCliLibrary,
    };

    return yield* runResolvedFamilyCommand(
      "diagnostics",
      COMMAND_HANDLERS,
      parsed.args,
      commandGlobals,
      parsed.options,
    );
  });
  const providedProgram = program.pipe(
    Effect.provide(layer),
    Effect.scoped,
  );

  return runFamilyEffect(providedProgram, globals);
};
