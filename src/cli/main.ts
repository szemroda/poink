import { Effect } from "effect";
import { fileURLToPath } from "url";
import { realpathSync } from "fs";
import { resolve } from "path";
import {
  makeErrorEnvelope,
  makeSuccessEnvelope,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "../agent/protocol.js";
import { setLogLevel } from "../logger.js";
import {
  installOpenAICodexShutdownHandlers,
  resolveConfiguredDefaultFormat,
  VERSION,
  type GlobalCLIOptions,
} from "./runner.js";
import { dispatchCommand } from "./commands.js";
import { writeEnvelope } from "./envelope.js";
import { runMcpServer } from "./mcp.js";
import {
  buildCliAppLayer,
  isServiceFreeCommand,
  withConfiguredLogging,
} from "./runtime.js";
import { runServeCommand } from "./serve.js";
import { parseCommandLine, type ParsedCommandLine } from "./commander.js";
import { CLIError, coerceCliError } from "./errors.js";
import {
  closeOpenAICodexProviderManager,
  withOpenAICodexProviderScope,
} from "../services/OpenAICodexProvider.js";

function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string" && OUTPUT_FORMATS.includes(value as OutputFormat);
}

function configuredGlobals(
  configuredDefaultFormat: OutputFormat,
  rawArgs: string[],
): GlobalCLIOptions {
  let format = configuredDefaultFormat;
  let pretty = false;
  let verbose = false;
  let logLevel: GlobalCLIOptions["logLevel"] = "error";

  if (rawArgs[0]?.startsWith("--")) {
    return {
      format,
      configuredDefaultFormat,
      pretty,
      verbose,
      logLevel,
    };
  }

  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--pretty") pretty = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (isOutputFormat(value)) format = value;
    } else if (arg === "--format") {
      const value = rawArgs[i + 1];
      if (isOutputFormat(value)) format = value;
      i++;
    } else if (arg.startsWith("--log-level=")) {
      const value = arg.slice("--log-level=".length);
      if (value === "silent" || value === "error" || value === "info" || value === "debug") {
        logLevel = value;
      }
    } else if (arg === "--log-level") {
      const value = rawArgs[i + 1];
      if (value === "silent" || value === "error" || value === "info" || value === "debug") {
        logLevel = value;
      }
      i++;
    }
  }

  return { format, configuredDefaultFormat, pretty, verbose, logLevel };
}

function writeCliError(
  globals: GlobalCLIOptions,
  command: string,
  error: CLIError,
  startedAt: number,
): void {
  if (globals.format === "text") {
    try {
      process.stderr.write(`${error.code}: ${error.message}\n`);
    } catch {
      // ignore
    }
    return;
  }

  writeEnvelope(
    globals.format,
    makeErrorEnvelope(
      command,
      { code: error.code, message: error.message, details: error.details },
      {
        verbose: globals.verbose,
        meta: {
          poinkVersion: VERSION,
          timingMs: Date.now() - startedAt,
        },
      },
    ),
    globals.pretty,
  );
}

async function executeParsed(parsed: ParsedCommandLine): Promise<number> {
  const startedAt = Date.now();
  const { args, globals } = parsed;
  setLogLevel(globals.logLevel);

  const command = args[0];

  if (command === "mcp") {
    try {
      await runMcpServer(buildCliAppLayer(), globals);
      return 0;
    } catch (error) {
      process.stderr.write(`MCP server failed: ${error}\n`);
      return 1;
    }
  }

  if (command === "serve") {
    try {
      await runServeCommand(buildCliAppLayer(), globals, args.slice(1));
      return 0;
    } catch (error) {
      const cliErr =
        error instanceof CLIError
          ? error
          : new CLIError("SERVE_FAILED", String(error), error);
      writeCliError(globals, "serve", cliErr, startedAt);
      return 1;
    }
  }

  const removeOpenAICodexShutdownHandlers = installOpenAICodexShutdownHandlers();
  let outEither: any;

  try {
    const program = dispatchCommand(args, globals, parsed.options);

    if (isServiceFreeCommand(command)) {
      outEither = await withOpenAICodexProviderScope(() =>
        Effect.runPromise(
          withConfiguredLogging(
            (program as Effect.Effect<any, any, never>).pipe(Effect.either),
            globals.logLevel,
          ),
        ),
      );
    } else {
      outEither = await withOpenAICodexProviderScope(() =>
        Effect.runPromise(
          withConfiguredLogging(
            program.pipe(Effect.provide(buildCliAppLayer()), Effect.scoped, Effect.either) as any,
            globals.logLevel,
          ),
        ),
      );
    }
  } catch (error) {
    removeOpenAICodexShutdownHandlers();
    try {
      await closeOpenAICodexProviderManager();
    } catch {
      // ignore cleanup errors while reporting the original failure
    }
    writeCliError(globals, command || "cli", coerceCliError(error), startedAt);
    return 1;
  }

  removeOpenAICodexShutdownHandlers();
  try {
    await closeOpenAICodexProviderManager();
  } catch {
    // ignore cleanup errors after command completion
  }

  if (outEither._tag === "Right") {
    const out: any = outEither.right;
    if (globals.format !== "text") {
      writeEnvelope(
        globals.format,
        makeSuccessEnvelope(out.command, out.result, {
          verbose: globals.verbose,
          nextActions: out.nextActions,
          meta: out.meta ?? { poinkVersion: VERSION },
        }),
        globals.pretty,
      );
    }
    return 0;
  }

  writeCliError(
    globals,
    command || "cli",
    coerceCliError(outEither.left),
    startedAt,
  );
  return 1;
}

export async function runCli(rawArgs: string[]): Promise<number> {
  const startedAt = Date.now();
  const configuredDefaultFormat = resolveConfiguredDefaultFormat();

  if (rawArgs.length === 0) {
    return executeParsed({
      args: ["--help"],
      options: {},
      globals: configuredGlobals(configuredDefaultFormat, rawArgs),
    });
  }

  if (rawArgs.length === 1 && (rawArgs[0] === "--help" || rawArgs[0] === "-h")) {
    return executeParsed({
      args: ["--help"],
      options: {},
      globals: configuredGlobals(configuredDefaultFormat, rawArgs),
    });
  }

  if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
    return executeParsed({
      args: ["--version"],
      options: {},
      globals: configuredGlobals(configuredDefaultFormat, rawArgs),
    });
  }

  let parsed: ParsedCommandLine;
  try {
    parsed = parseCommandLine(rawArgs, configuredDefaultFormat);
  } catch (error) {
    const globals = configuredGlobals(configuredDefaultFormat, rawArgs);
    writeCliError(
      globals,
      rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs[0] : "cli",
      coerceCliError(error),
      startedAt,
    );
    return 1;
  }

  return executeParsed(parsed);
}

export function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
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
  const exitCode = await runCli(argv.slice(2));
  process.exit(exitCode);
}
