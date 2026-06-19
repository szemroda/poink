import { Effect } from "effect";
import type { Layer } from "effect";
import { LibraryStore } from "../../services/LibraryStore.js";
import { DocumentIntegrityRepository } from "../../services/StorageRepositories.js";
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

const LIBRARY_COMMANDS = new Set([
  "chunk",
  "doc",
  "page",
  "list",
  "read",
  "get",
  "remove",
  "tag",
  "stats",
]);

function unknownStoreCommand(command: string | undefined): CLIError {
  return new CLIError(
    "UNKNOWN_COMMAND",
    `Unknown store command: ${command}`,
  );
}

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const layer = await buildStoreLayer(config);
  const program = Effect.gen(function* () {
    const store = yield* LibraryStore;
    const integrity = yield* DocumentIntegrityRepository;
    const commandGlobals = {
      ...globals,
      library: {
        ...store,
        getWithSourceIdentity: integrity.getDocumentWithSourceIdentity,
        listWithSourceIdentity: integrity.listDocumentsWithSourceIdentity,
      } as CliLibrary,
    };
    const command = parsed.args[0];
    if (command === "repair") {
      return yield* runRepairCommand(
        parsed.args,
        commandGlobals,
        parsed.options,
      );
    }
    if (!command || !LIBRARY_COMMANDS.has(command)) {
      return yield* Effect.fail(unknownStoreCommand(command));
    }

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
  });
  return runFamilyEffect(
    program,
    globals,
    layer as unknown as Layer.Layer<unknown, unknown, never>,
  );
};
