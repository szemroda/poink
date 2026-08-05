import { Effect } from "effect";
import { DocumentIngestion } from "../../services/DocumentIngestion.js";
import { LibraryStore } from "../../services/LibraryStore.js";
import { SemanticLibrary } from "../../services/SemanticLibrary.js";
import { DocumentIntegrityRepository } from "../../services/StorageRepositories.js";
import { AutoTagger } from "../../services/AutoTagger.js";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import { OfficeExtractor } from "../../services/OfficeExtractor.js";
import { PDFExtractor } from "../../services/PDFExtractor.js";
import { SourceFileTypeDetector } from "../../services/SourceFileType.js";
import { runAddCommand } from "../commands/add.js";
import { runIngestCommand } from "../commands/ingest.js";
import { runRechunkCommand } from "../commands/rechunk.js";
import { runReindexCommand } from "../commands/reindex.js";
import {
  type CliLibrary,
  type CommandExecutionOutput,
  type GlobalCLIOptionsWithLibrary,
} from "../runner.js";
import { buildIngestionLayer } from "../runtime.js";
import {
  commandHandlers,
  type KnownFamilyError,
  runFamilyEffect,
  runResolvedFamilyCommand,
} from "./shared.js";
import type { FamilyRunner } from "./types.js";

type IngestionCommandServices =
  | AutoTagger
  | EmbeddingProvider
  | OfficeExtractor
  | PDFExtractor
  | SourceFileTypeDetector;

type IngestionCommandError =
  | Effect.Effect.Error<ReturnType<typeof runAddCommand>>
  | Effect.Effect.Error<ReturnType<typeof runIngestCommand>>
  | Effect.Effect.Error<ReturnType<typeof runRechunkCommand>>
  | Effect.Effect.Error<ReturnType<typeof runReindexCommand>>;

const COMMAND_HANDLERS = commandHandlers<
  CommandExecutionOutput,
  KnownFamilyError<IngestionCommandError>,
  IngestionCommandServices,
  GlobalCLIOptionsWithLibrary<CliLibrary>
>([
  ["add", runAddCommand],
  ["ingest", runIngestCommand],
  ["rechunk", runRechunkCommand],
  ["reindex", runReindexCommand],
]);

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
    const integrity = yield* DocumentIntegrityRepository;
    const commandGlobals = {
      ...globals,
      library: {
        ...store,
        ...semantic,
        ...ingestion,
        getWithSourceIdentity: integrity.getDocumentWithSourceIdentity,
        listWithSourceIdentity: integrity.listDocumentsWithSourceIdentity,
      } satisfies CliLibrary,
    };
    return yield* runResolvedFamilyCommand(
      "ingestion",
      COMMAND_HANDLERS,
      parsed.args,
      commandGlobals,
      parsed.options,
    );
  });

  const providedProgram = program.pipe(Effect.provide(layer), Effect.scoped);

  return runFamilyEffect(providedProgram, globals);
};
