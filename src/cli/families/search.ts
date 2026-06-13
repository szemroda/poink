import { Effect } from "effect";
import { LibraryStore } from "../../services/LibraryStore.js";
import { SemanticLibrary } from "../../services/SemanticLibrary.js";
import { runSearchCommand } from "../commands/search.js";
import { runTaxonomyCommand } from "../commands/taxonomy.js";
import {
  CLIError,
  type CliLibrary,
  type GlobalCLIOptions,
} from "../runner.js";
import { buildSearchLayer } from "../runtime.js";
import { runFamilyEffect } from "./shared.js";
import type { FamilyRunner } from "./types.js";

type SearchCommandHandler = (
  args: string[],
  globals: GlobalCLIOptions,
  options: Record<string, unknown>,
) => Effect.Effect<unknown, unknown, unknown>;

const COMMAND_HANDLERS: Readonly<Record<string, SearchCommandHandler>> = {
  search: runSearchCommand,
  "search-pack": runSearchCommand,
  taxonomy: runTaxonomyCommand,
};

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
    const command = parsed.args[0];
    const handler = command ? COMMAND_HANDLERS[command] : undefined;
    if (!handler) {
      return yield* Effect.fail(
        new CLIError(
          "UNKNOWN_COMMAND",
          `Unknown search command: ${command}`,
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
