import { Effect } from "effect";
export { runAddCommand } from "./commands/add.js";
import { runAddCommand } from "./commands/add.js";
export { runCapabilitiesCommand } from "./commands/capabilities.js";
import { runCapabilitiesCommand } from "./commands/capabilities.js";
export { runConfigCommand } from "./commands/config.js";
import { runConfigCommand } from "./commands/config.js";
export { runDoctorCommand } from "./commands/doctor.js";
import { runDoctorCommand } from "./commands/doctor.js";
export { runIngestCommand } from "./commands/ingest.js";
import { runIngestCommand } from "./commands/ingest.js";
export { runInitCommand } from "./commands/init.js";
import { runInitCommand } from "./commands/init.js";
export { runLibraryCommand } from "./commands/library.js";
import { runLibraryCommand } from "./commands/library.js";
export { runProvidersCommand } from "./commands/providers.js";
import { runProvidersCommand } from "./commands/providers.js";
export { runRechunkCommand } from "./commands/rechunk.js";
import { runRechunkCommand } from "./commands/rechunk.js";
export { runReindexCommand } from "./commands/reindex.js";
import { runReindexCommand } from "./commands/reindex.js";
export { runRepairCommand } from "./commands/repair.js";
import { runRepairCommand } from "./commands/repair.js";
export { runSearchCommand } from "./commands/search.js";
import { runSearchCommand } from "./commands/search.js";
export { runSetupCommand } from "./commands/setup.js";
import { runSetupCommand } from "./commands/setup.js";
export { runTaxonomyCommand } from "./commands/taxonomy.js";
import { runTaxonomyCommand } from "./commands/taxonomy.js";
export { runUnsupportedCommand } from "./commands/unsupported.js";
import { runUnsupportedCommand } from "./commands/unsupported.js";
export type { CliCommandOutput, CliConsole } from "./commands/types.js";
import {
  CLIError,
  runCommandWithContext,
  type GlobalCLIOptions,
} from "./runner.js";
import { renderHelp } from "../agent/manifest.js";
import { VERSION } from "./runner.js";

export function dispatchCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: Record<string, unknown> = {},
): Effect.Effect<any, any, any> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return runCommandWithContext(args, globals, ({ Console, format, getLoadedLibraryStats, startedAt }) =>
      Effect.gen(function* () {
        const serviceFreeHelp = args[0] === "config" || args[0] === "providers";
        const stats = serviceFreeHelp
          ? { _tag: "Left" as const }
          : yield* getLoadedLibraryStats();
        const statsData = stats._tag === "Right" ? stats.right : undefined;
        if (format === "text") {
          yield* Console.log(renderHelp(statsData));
          return { command: "help", resultPayload: null, agentResult: null, meta: null };
        }
        return {
          command: "help",
          resultPayload: { help: renderHelp(statsData) },
          agentResult: null,
          meta: { poinkVersion: VERSION, timingMs: Date.now() - startedAt },
        };
      }),
    options);
  }

  if (args.includes("--version") || args.includes("-v")) {
    return runCommandWithContext(args, globals, ({ Console, format, startedAt }) =>
      Effect.gen(function* () {
        if (format === "text") {
          yield* Console.log(`poink v${VERSION}`);
          return { command: "version", resultPayload: null, agentResult: null, meta: null };
        }
        return {
          command: "version",
          resultPayload: { version: VERSION },
          agentResult: null,
          meta: { poinkVersion: VERSION, timingMs: Date.now() - startedAt },
        };
      }),
    options);
  }

  switch (args[0]) {
    case "--help":
      return runCommandWithContext(args, globals, ({ Console, format, getLoadedLibraryStats, startedAt }) =>
        Effect.gen(function* () {
          const stats = yield* getLoadedLibraryStats();
          const statsData = stats._tag === "Right" ? stats.right : undefined;
          if (format === "text") {
            yield* Console.log(renderHelp(statsData));
            return { command: "help", resultPayload: null, agentResult: null, meta: null };
          }
          return {
            command: "help",
            resultPayload: { help: renderHelp(statsData) },
            agentResult: null,
            meta: { poinkVersion: VERSION, timingMs: Date.now() - startedAt },
          };
        }),
      );
    case "--version":
      return runCommandWithContext(args, globals, ({ Console, format, startedAt }) =>
        Effect.gen(function* () {
          if (format === "text") {
            yield* Console.log(`poink v${VERSION}`);
            return { command: "version", resultPayload: null, agentResult: null, meta: null };
          }
          return {
            command: "version",
            resultPayload: { version: VERSION },
            agentResult: null,
            meta: { poinkVersion: VERSION, timingMs: Date.now() - startedAt },
          };
        }),
      );
    case "capabilities":
      return runCapabilitiesCommand(args, globals, options);
    case "add":
      return runAddCommand(args, globals, options);
    case "search":
    case "search-pack":
      return runSearchCommand(args, globals, options);
    case "taxonomy":
      return runTaxonomyCommand(args, globals, options);
    case "doctor":
    case "check":
      return runDoctorCommand(args, globals, options);
    case "init":
      return runInitCommand(args, globals, options);
    case "repair":
      return runRepairCommand(args, globals, options);
    case "ingest":
      return runIngestCommand(args, globals, options);
    case "reindex":
      return runReindexCommand(args, globals, options);
    case "rechunk":
      return runRechunkCommand(args, globals, options);
    case "config":
      return runCommandWithContext(args, globals, ({ Console }) =>
        runConfigCommand(args, Console),
    options);
    case "providers":
      return runCommandWithContext(args, globals, ({ Console, format }) =>
        runProvidersCommand(args, format, Console, options),
      options);
    case "setup":
      return runSetupCommand(args, globals, options);
    case "chunk":
    case "doc":
    case "page":
    case "list":
    case "read":
    case "get":
    case "remove":
    case "tag":
    case "stats":
      return runCommandWithContext(args, globals, ({ Console, format, library }) =>
        runLibraryCommand(args, format, library, Console),
    options);
    default:
      return runCommandWithContext(args, globals, ({ command }) =>
        Effect.fail(
          new CLIError("UNKNOWN_COMMAND", `Unknown command: ${command}`, {
            command,
          }),
        ),
      );
  }
}
