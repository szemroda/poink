import { Effect } from "effect";
import { LibraryStore } from "../../services/LibraryStore.js";
import { SemanticLibrary } from "../../services/SemanticLibrary.js";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import { TaxonomyService } from "../../services/TaxonomyService.js";
import { runSearchCommand } from "../commands/search.js";
import { runTaxonomyCommand } from "../commands/taxonomy.js";
import {
  type CommandExecutionOutput,
  type GlobalCLIOptionsWithLibrary,
  type SearchCliLibrary,
} from "../runner.js";
import { buildSearchLayer } from "../runtime.js";
import {
  commandHandlers,
  type KnownFamilyError,
  runFamilyEffect,
  runResolvedFamilyCommand,
} from "./shared.js";
import type { FamilyRunner } from "./types.js";

type SearchServices = EmbeddingProvider | TaxonomyService;
type SearchCommandError =
  | Effect.Effect.Error<ReturnType<typeof runSearchCommand>>
  | Effect.Effect.Error<ReturnType<typeof runTaxonomyCommand>>;

const COMMAND_HANDLERS = commandHandlers<
  CommandExecutionOutput,
  KnownFamilyError<SearchCommandError>,
  SearchServices,
  GlobalCLIOptionsWithLibrary<SearchCliLibrary>
>([
  ["search", runSearchCommand],
  ["search-pack", runSearchCommand],
  ["taxonomy", runTaxonomyCommand],
]);

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const layer = await buildSearchLayer(config);
  const program = Effect.gen(function* () {
    const store = yield* LibraryStore;
    const semantic = yield* SemanticLibrary;
    const commandGlobals = {
      ...globals,
      library: {
        ...store,
        ...semantic,
      } satisfies SearchCliLibrary,
    };
    return yield* runResolvedFamilyCommand(
      "search",
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
