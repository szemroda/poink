import { Effect } from "effect";
import type { Layer } from "effect";
import { LibraryStore } from "../../services/LibraryStore.js";
import { SemanticLibrary } from "../../services/SemanticLibrary.js";
import { runSearchCommand } from "../commands/search.js";
import { runTaxonomyCommand } from "../commands/taxonomy.js";
import { CLIError, type CliLibrary } from "../runner.js";
import { buildSearchLayer } from "../runtime.js";
import { runFamilyEffect } from "./shared.js";
import type { FamilyRunner } from "./types.js";

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
    if (
      parsed.args[0] === "search" ||
      parsed.args[0] === "search-pack"
    ) {
      return yield* runSearchCommand(
        parsed.args,
        commandGlobals,
        parsed.options,
      );
    }
    if (parsed.args[0] === "taxonomy") {
      return yield* runTaxonomyCommand(
        parsed.args,
        commandGlobals,
        parsed.options,
      );
    }
    return yield* Effect.fail(
      new CLIError(
        "UNKNOWN_COMMAND",
        `Unknown search command: ${parsed.args[0]}`,
      ),
    );
  });
  return runFamilyEffect(
    program,
    globals,
    layer as unknown as Layer.Layer<unknown, unknown, never>,
  );
};
