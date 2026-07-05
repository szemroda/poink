import { Effect } from "effect";
import { LibraryStore } from "../../services/LibraryStore.js";
import { SemanticLibrary } from "../../services/SemanticLibrary.js";
import { runSearchCommand } from "../commands/search.js";
import { runTaxonomyCommand } from "../commands/taxonomy.js";
import { type CliLibrary } from "../runner.js";
import { buildSearchLayer } from "../runtime.js";
import {
  commandHandlers,
  runFamilyEffect,
  runResolvedFamilyCommand,
} from "./shared.js";
import type { FamilyRunner } from "./types.js";

const COMMAND_HANDLERS = commandHandlers([
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
      library: { ...store, ...semantic } as CliLibrary,
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
