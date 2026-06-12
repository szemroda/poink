import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeErrorEnvelope,
  makeSuccessEnvelope,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "../agent/protocol.js";
import { setLogLevel } from "../logger.js";
import { Config, loadConfig } from "../types.js";
import { parseCommandLine, type ParsedCommandLine } from "./commander.js";
import { writeEnvelope } from "./envelope.js";
import { coerceCliError } from "./errors.js";
import {
  resolveConfiguredDefaultFormat,
  VERSION,
  type GlobalCLIOptions,
} from "./runner.js";
import {
  createInvocationTiming,
  createProcessInvocationTiming,
  type InvocationTiming,
} from "./timing.js";
import type { FamilyRunner } from "./families/types.js";

export type CommandFamily =
  | "lightweight"
  | "store"
  | "search"
  | "ingestion"
  | "setup"
  | "diagnostics"
  | "server";

export const COMMAND_FAMILIES: Readonly<Record<string, CommandFamily>> = {
  help: "lightweight",
  version: "lightweight",
  "--help": "lightweight",
  "--version": "lightweight",
  capabilities: "lightweight",
  config: "lightweight",
  chunk: "store",
  doc: "store",
  page: "store",
  list: "store",
  read: "store",
  get: "store",
  remove: "store",
  tag: "store",
  stats: "store",
  repair: "store",
  search: "search",
  "search-pack": "search",
  taxonomy: "search",
  add: "ingestion",
  ingest: "ingestion",
  reindex: "ingestion",
  rechunk: "ingestion",
  providers: "setup",
  setup: "setup",
  doctor: "diagnostics",
  check: "diagnostics",
  init: "diagnostics",
  mcp: "server",
  serve: "server",
};

function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string" && OUTPUT_FORMATS.includes(value as OutputFormat);
}

function isHelpOrVersionInvocation(rawArgs: string[]): boolean {
  return (
    rawArgs[0] === "help" ||
    rawArgs[0] === "version" ||
    rawArgs.some(
      (arg) =>
        arg === "--help" ||
        arg === "-h" ||
        arg === "--version" ||
        arg === "-v",
    )
  );
}

function usesOpenAICodex(
  family: CommandFamily,
  parsed: ParsedCommandLine,
  config: Config,
): boolean {
  const command = parsed.args[0];
  const usesLanguageModel =
    (command === "add" || command === "ingest" || command === "rechunk") &&
    (parsed.options.enrich === true ||
      parsed.options.visuals === true ||
      parsed.options.autoTag === true ||
      parsed.options["auto-tag"] === true ||
      config.ingest.visuals.enabled);
  return (
    family === "ingestion" &&
    usesLanguageModel &&
    (parsed.options.provider === "openai-codex" ||
      config.models.enrichment.provider === "openai-codex" ||
      config.models.judge.provider === "openai-codex")
  );
}

async function runFamilyRunner(
  runner: FamilyRunner,
  input: Parameters<FamilyRunner>[0],
  family: CommandFamily,
): Promise<unknown> {
  if (!usesOpenAICodex(family, input.parsed, input.config)) {
    return runner(input);
  }

  const { withOpenAICodexProviderScope } = await import(
    "../services/OpenAICodexProvider.js"
  );
  return withOpenAICodexProviderScope(() => runner(input));
}

function configuredGlobals(
  configuredDefaultFormat: OutputFormat,
  rawArgs: string[],
): Omit<GlobalCLIOptions, "config" | "timing"> {
  let format = configuredDefaultFormat;
  let pretty = false;
  let verbose = false;
  let logLevel: GlobalCLIOptions["logLevel"] = "error";
  if (rawArgs[0]?.startsWith("--")) {
    return { format, configuredDefaultFormat, pretty, verbose, logLevel };
  }
  for (let index = 1; index < rawArgs.length; index++) {
    const arg = rawArgs[index]!;
    if (arg === "--pretty") pretty = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (isOutputFormat(value)) format = value;
    } else if (arg === "--format") {
      const value = rawArgs[index + 1];
      if (isOutputFormat(value)) format = value;
      index++;
    } else if (arg.startsWith("--log-level=")) {
      const value = arg.slice("--log-level=".length);
      if (
        value === "silent" ||
        value === "error" ||
        value === "info" ||
        value === "debug"
      ) {
        logLevel = value;
      }
    } else if (arg === "--log-level") {
      const value = rawArgs[index + 1];
      if (
        value === "silent" ||
        value === "error" ||
        value === "info" ||
        value === "debug"
      ) {
        logLevel = value;
      }
      index++;
    }
  }
  return { format, configuredDefaultFormat, pretty, verbose, logLevel };
}

function writeCliError(
  globals: GlobalCLIOptions,
  command: string,
  error: ReturnType<typeof coerceCliError>,
  timing: InvocationTiming,
): void {
  if (globals.format === "text") {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    return;
  }
  writeEnvelope(
    globals.format,
    makeErrorEnvelope(
      command,
      { code: error.code, message: error.message, details: error.details },
      {
        verbose: globals.verbose,
        meta: timing.toAgentMeta(VERSION),
      },
    ),
    globals.pretty,
  );
}

export function getCommandFamily(parsed: ParsedCommandLine): CommandFamily {
  if (parsed.args.includes("--help") || parsed.args.includes("-h")) {
    return "lightweight";
  }
  if (parsed.args.includes("--version") || parsed.args.includes("-v")) {
    return "lightweight";
  }
  return COMMAND_FAMILIES[parsed.args[0] ?? "--help"] ?? "lightweight";
}

async function loadFamilyRunner(family: CommandFamily): Promise<FamilyRunner> {
  switch (family) {
    case "lightweight":
      return (await import("./families/lightweight.js")).runFamily;
    case "store":
      return (await import("./families/store.js")).runFamily;
    case "search":
      return (await import("./families/search.js")).runFamily;
    case "ingestion":
      return (await import("./families/ingestion.js")).runFamily;
    case "setup":
      return (await import("./families/setup.js")).runFamily;
    case "diagnostics":
      return (await import("./families/diagnostics.js")).runFamily;
    case "server":
      return (await import("./families/server.js")).runFamily;
  }
}

function isEither(
  value: unknown,
): value is
  | { _tag: "Right"; right: { command: string; result: unknown; nextActions?: never } }
  | { _tag: "Left"; left: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value._tag === "Right" || value._tag === "Left")
  );
}

async function runCliWithTiming(
  rawArgs: string[],
  timing: InvocationTiming,
): Promise<number> {
  const normalizedArgs =
    rawArgs.length === 0
      ? ["--help"]
      : rawArgs.length === 1 && rawArgs[0] === "-h"
        ? ["--help"]
        : rawArgs.length === 1 && rawArgs[0] === "-v"
          ? ["--version"]
          : rawArgs;
  const bootstrapCommand = normalizedArgs[0] ?? "--help";
  const malformedConfigIsNonFatal = isHelpOrVersionInvocation(normalizedArgs);

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!malformedConfigIsNonFatal) {
      const globals = {
        ...configuredGlobals("text", normalizedArgs),
        timing,
      };
      writeCliError(
        globals,
        bootstrapCommand.startsWith("-") ? "cli" : bootstrapCommand,
        coerceCliError(error),
        timing,
      );
      return 1;
    }
    config = Config.Default;
  }

  const configuredDefaultFormat = resolveConfiguredDefaultFormat(config);
  let parsed: ParsedCommandLine;
  try {
    parsed =
      normalizedArgs.length === 1 && normalizedArgs[0] === "--help"
        ? {
            args: ["--help"],
            options: {},
            globals: configuredGlobals(
              configuredDefaultFormat,
              normalizedArgs,
            ),
          }
        : normalizedArgs.length === 1 && normalizedArgs[0] === "--version"
          ? {
              args: ["--version"],
              options: {},
              globals: configuredGlobals(
                configuredDefaultFormat,
                normalizedArgs,
              ),
            }
          : parseCommandLine(normalizedArgs, configuredDefaultFormat);
  } catch (error) {
    const globals = {
      ...configuredGlobals(configuredDefaultFormat, normalizedArgs),
      config,
      timing,
    };
    writeCliError(
      globals,
      bootstrapCommand.startsWith("-") ? "cli" : bootstrapCommand,
      coerceCliError(error),
      timing,
    );
    return 1;
  }

  const globals: GlobalCLIOptions = {
    ...parsed.globals,
    config,
    timing,
  };
  setLogLevel(globals.logLevel);

  try {
    const family = getCommandFamily(parsed);
    const runner = await loadFamilyRunner(family);
    const outcome = await runFamilyRunner(
      runner,
      { parsed, globals, config, timing },
      family,
    );
    if (!isEither(outcome)) return 0;
    if (outcome._tag === "Left") {
      writeCliError(
        globals,
        parsed.args[0] ?? "cli",
        coerceCliError(outcome.left),
        timing,
      );
      return 1;
    }
    const output = outcome.right;
    if (globals.format !== "text") {
      writeEnvelope(
        globals.format,
        makeSuccessEnvelope(output.command, output.result, {
          verbose: globals.verbose,
          nextActions: output.nextActions,
          meta: timing.toAgentMeta(VERSION),
        }),
        globals.pretty,
      );
    }
    return 0;
  } catch (error) {
    writeCliError(
      globals,
      parsed.args[0] ?? "cli",
      coerceCliError(error),
      timing,
    );
    return 1;
  }
}

export function runCli(rawArgs: string[]): Promise<number> {
  return runCliWithTiming(rawArgs, createInvocationTiming());
}

export function isMainModule(
  metaUrl: string,
  argvPath: string | undefined,
): boolean {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(metaUrl);
  const resolvedArgvPath = resolve(argvPath);
  try {
    return realpathSync(modulePath) === realpathSync(resolvedArgvPath);
  } catch {
    return modulePath === resolvedArgvPath;
  }
}

export async function runMain(argv: string[] = process.argv): Promise<void> {
  const exitCode = await runCliWithTiming(
    argv.slice(2),
    createProcessInvocationTiming(),
  );
  process.exit(exitCode);
}
