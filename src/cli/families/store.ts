import { Effect } from "effect";
import { LibraryStore } from "../../services/LibraryStore.js";
import { DocumentIntegrityRepository } from "../../services/StorageRepositories.js";
import { runLibraryCommand } from "../commands/library.js";
import { runRepairCommand } from "../commands/repair.js";
import {
  runCommandWithLibraryContext,
  type CommandExecutionOutput,
  type GlobalCLIOptionsWithLibrary,
  type StoreCliLibrary,
} from "../runner.js";
import { buildStoreLayer } from "../runtime.js";
import {
  commandHandlers,
  type KnownFamilyError,
  runFamilyEffect,
  runResolvedFamilyCommand,
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
  globals: GlobalCLIOptionsWithLibrary<StoreCliLibrary>,
  options: Record<string, unknown>,
) {
  return runCommandWithLibraryContext(
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

type StoreCommandError =
  | Effect.Effect.Error<ReturnType<typeof runRepairCommand>>
  | Effect.Effect.Error<ReturnType<typeof runStoreLibraryCommand>>;

const COMMAND_HANDLERS = commandHandlers<
  CommandExecutionOutput,
  KnownFamilyError<StoreCommandError>,
  never,
  GlobalCLIOptionsWithLibrary<StoreCliLibrary>
>([
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
      } satisfies StoreCliLibrary,
    };
    return yield* runResolvedFamilyCommand(
      "store",
      COMMAND_HANDLERS,
      parsed.args,
      commandGlobals,
      parsed.options,
    );
  });
  return runFamilyEffect(
    program.pipe(Effect.provide(layer), Effect.scoped),
    globals,
  );
};
