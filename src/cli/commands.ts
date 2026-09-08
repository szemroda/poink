import { Effect } from "effect";
import { renderHelp } from "../agent/manifest.js";
import { AutoTagger } from "../services/AutoTagger.js";
import { EmbeddingProvider } from "../services/EmbeddingProvider.js";
import { OfficeExtractor } from "../services/OfficeExtractor.js";
import { PDFExtractor } from "../services/PDFExtractor.js";
import { SourceFileTypeDetector } from "../services/SourceFileType.js";
import { TaxonomyService } from "../services/TaxonomyService.js";
import { runAddCommand } from "./commands/add.js";
import { runCapabilitiesCommand } from "./commands/capabilities.js";
import { runConfigCommand } from "./commands/config.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runIngestCommand } from "./commands/ingest.js";
import { runInitCommand } from "./commands/init.js";
import { runLibraryCommand } from "./commands/library.js";
import { runProvidersCommand } from "./commands/providers.js";
import { runRechunkCommand } from "./commands/rechunk.js";
import { runReindexCommand } from "./commands/reindex.js";
import { runRepairCommand } from "./commands/repair.js";
import { runSearchCommand } from "./commands/search.js";
import { runSetupCommand } from "./commands/setup.js";
import { runTaxonomyCommand } from "./commands/taxonomy.js";
import {
  CLIError,
  type CommandExecutionOutput,
  type GlobalCLIOptionsWithLibrary,
  type GlobalCLIOptions,
  runCommandWithLibraryContext,
  runCommandWithContext,
  VERSION,
} from "./runner.js";

export {
  runAddCommand,
  runCapabilitiesCommand,
  runConfigCommand,
  runDoctorCommand,
  runIngestCommand,
  runInitCommand,
  runLibraryCommand,
  runProvidersCommand,
  runRechunkCommand,
  runReindexCommand,
  runRepairCommand,
  runSearchCommand,
  runSetupCommand,
  runTaxonomyCommand,
};
export type { CliCommandOutput, CliConsole } from "./commands/types.js";

const SEARCH_COMMANDS = new Set(["search", "search-pack"]);
const DOCTOR_COMMANDS = new Set(["doctor", "check"]);
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

export type CommandServices =
  | AutoTagger
  | EmbeddingProvider
  | OfficeExtractor
  | PDFExtractor
  | SourceFileTypeDetector
  | TaxonomyService;

type CommandEffectError<T> = T extends (
  ...args: infer _Args
) => Effect.Effect<unknown, infer E, unknown>
  ? E
  : never;

type DerivedCommandError = CommandEffectError<
  | typeof runAddCommand
  | typeof runCapabilitiesCommand
  | typeof runConfigCommand
  | typeof runDoctorCommand
  | typeof runIngestCommand
  | typeof runInitCommand
  | typeof runLibraryCommand
  | typeof runProvidersCommand
  | typeof runRechunkCommand
  | typeof runReindexCommand
  | typeof runRepairCommand
  | typeof runSearchCommand
  | typeof runSetupCommand
  | typeof runTaxonomyCommand
>;

export type CommandError =
  unknown extends DerivedCommandError ? never : DerivedCommandError | CLIError;

type CommandRunner = (
  args: string[],
  globals: GlobalCLIOptionsWithLibrary,
  options: Record<string, unknown>,
) => Effect.Effect<CommandExecutionOutput, CommandError, CommandServices>;

const DIRECT_COMMANDS = new Map<string, CommandRunner>([
  ["capabilities", runCapabilitiesCommand],
  ["add", runAddCommand],
  ["taxonomy", runTaxonomyCommand],
  ["init", runInitCommand],
  ["repair", runRepairCommand],
  ["ingest", runIngestCommand],
  ["reindex", runReindexCommand],
  ["rechunk", runRechunkCommand],
  ["setup", runSetupCommand],
]);

function runInformationalCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: Record<string, unknown>,
  command: "help" | "version",
  message: string,
  resultPayload: Record<string, string>,
) {
  return runCommandWithContext(
    args,
    globals,
    ({ Console, format }) =>
      Effect.gen(function* () {
        if (format === "text") {
          yield* Console.log(message);
        }
        return {
          command,
          resultPayload: format === "text" ? null : resultPayload,
          agentResult: null,
        };
      }),
    options,
  );
}

export function dispatchCommand(
  args: string[],
  globals: GlobalCLIOptionsWithLibrary,
  options: Record<string, unknown> = {},
) {
  const command = args[0];
  if (!command || args.includes("--help") || args.includes("-h")) {
    const help = renderHelp();
    return runInformationalCommand(
      args,
      globals,
      options,
      "help",
      help,
      { help },
    );
  }

  if (args.includes("--version") || args.includes("-v")) {
    return runInformationalCommand(
      args,
      globals,
      options,
      "version",
      `poink v${VERSION}`,
      { version: VERSION },
    );
  }

  const directCommand = DIRECT_COMMANDS.get(command);
  if (directCommand) {
    return directCommand(args, globals, options);
  }
  if (SEARCH_COMMANDS.has(command)) {
    return runSearchCommand(args, globals, options);
  }
  if (DOCTOR_COMMANDS.has(command)) {
    return runDoctorCommand(args, globals, options);
  }
  if (command === "config") {
    return runCommandWithLibraryContext(
      args,
      globals,
      ({ Console }) => runConfigCommand(args, Console, globals.config!),
      options,
    );
  }
  if (command === "providers") {
    return runCommandWithContext(
      args,
      globals,
      ({ Console, format }) =>
        runProvidersCommand(args, format, Console, options, globals.config),
      options,
    );
  }
  if (LIBRARY_COMMANDS.has(command)) {
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

  return runCommandWithContext(args, globals, ({ command }) =>
    Effect.fail(
      new CLIError("UNKNOWN_COMMAND", `Unknown command: ${command}`, {
        command,
      }),
    ),
  );
}
