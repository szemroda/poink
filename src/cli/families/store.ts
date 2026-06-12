import { Effect } from "effect";
import type { Layer } from "effect";
import { LibraryStore } from "../../services/LibraryStore.js";
import { runLibraryCommand } from "../commands/library.js";
import { runRepairCommand } from "../commands/repair.js";
import {
  CLIError,
  runCommandWithContext,
  type CliLibrary,
} from "../runner.js";
import { buildStoreLayer } from "../runtime.js";
import { runFamilyEffect } from "./shared.js";
import type { FamilyRunner } from "./types.js";

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const layer = await buildStoreLayer(config);
  const program = Effect.gen(function* () {
    const store = yield* LibraryStore;
    const commandGlobals = {
      ...globals,
      library: store as CliLibrary,
    };
    const command = parsed.args[0];
    if (command === "repair") {
      return yield* runRepairCommand(
        parsed.args,
        commandGlobals,
        parsed.options,
      );
    }
    if (
      command === "chunk" ||
      command === "doc" ||
      command === "page" ||
      command === "list" ||
      command === "read" ||
      command === "get" ||
      command === "remove" ||
      command === "tag" ||
      command === "stats"
    ) {
      return yield* runCommandWithContext(
        parsed.args,
        commandGlobals,
        ({ Console, format, library, globals: contextGlobals }) =>
          runLibraryCommand(
            parsed.args,
            format,
            library,
            Console,
            contextGlobals.verbose,
            parsed.options,
          ),
        parsed.options,
      );
    }
    return yield* Effect.fail(
      new CLIError("UNKNOWN_COMMAND", `Unknown store command: ${command}`),
    );
  });
  return runFamilyEffect(
    program,
    globals,
    layer as unknown as Layer.Layer<unknown, unknown, never>,
  );
};
