import { Effect } from "effect";
import { LibraryStore } from "../../services/LibraryStore.js";
import { DocumentIntegrityRepository } from "../../services/StorageRepositories.js";
import { runLibraryCommand } from "../commands/library.js";
import { runRepairCommand } from "../commands/repair.js";
import {
  runCommandWithContext,
  type CliLibrary,
  type GlobalCLIOptions,
} from "../runner.js";
import { buildStoreLayer } from "../runtime.js";
import {
  commandHandlers,
  runFamilyEffect,
  runResolvedFamilyCommand,
  toFamilyLayer,
} from "./shared.js";
import type { FamilyRunner } from "./types.js";

const LIBRARY_COMMANDS = [
  "chunk",
  "doc",
  "page",
  "list",
  "read",
  "get",
  "remove",
  "tag",
  "stats",
] as const;

function runStoreLibraryCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: Record<string, unknown>,
) {
  return runCommandWithContext(
    args,
    globals,
    ({ Console, format, library, globals: contextGlobals }) =>
      runLibraryCommand(
        args,
        format,
        library,
        Console,
        contextGlobals.verbose,
        options,
      ),
    options,
  );
}

const COMMAND_HANDLERS = commandHandlers([
  ["repair", runRepairCommand],
  ...LIBRARY_COMMANDS.map(
    (command) => [command, runStoreLibraryCommand] as const,
  ),
]);

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
    return yield* runResolvedFamilyCommand(
      "store",
      COMMAND_HANDLERS,
      parsed.args,
      commandGlobals,
      parsed.options,
    );
  });
  return runFamilyEffect(program, globals, toFamilyLayer(layer));
};
