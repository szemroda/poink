import { runCapabilitiesCommand } from "./commands/capabilities.js";
import { runConfigCommand } from "./commands/config.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runLibraryCommand } from "./commands/library.js";
import { runRechunkCommand } from "./commands/rechunk.js";
import { runTaxonomyCommand } from "./commands/taxonomy.js";
import {
  type GlobalCLIOptionsWithLibrary,
  runCommandWithLibraryContext,
} from "./runner.js";
import type { EmbeddingProvider } from "../services/EmbeddingProvider.js";
import type { TaxonomyService } from "../services/TaxonomyService.js";

export type CommandServices = EmbeddingProvider | TaxonomyService;

function runLibraryWithContext(
  args: string[],
  globals: GlobalCLIOptionsWithLibrary,
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
  );
}

function runConfigWithContext(
  args: string[],
  globals: GlobalCLIOptionsWithLibrary,
) {
  return runCommandWithLibraryContext(args, globals, ({ Console }) =>
    runConfigCommand(args, Console, globals.config!),
  );
}

/** Commands the MCP tools in mcp.ts dispatch by argv (search has its own path). */
const MCP_COMMANDS = {
  capabilities: runCapabilitiesCommand,
  config: runConfigWithContext,
  doctor: runDoctorCommand,
  rechunk: runRechunkCommand,
  taxonomy: runTaxonomyCommand,
  chunk: runLibraryWithContext,
  doc: runLibraryWithContext,
  page: runLibraryWithContext,
  list: runLibraryWithContext,
  read: runLibraryWithContext,
  stats: runLibraryWithContext,
};

export type McpCommandArgv = [keyof typeof MCP_COMMANDS, ...string[]];

export function dispatchCommand(
  args: McpCommandArgv,
  globals: GlobalCLIOptionsWithLibrary,
  options: Record<string, unknown> = {},
) {
  return MCP_COMMANDS[args[0]](args, globals, options);
}
