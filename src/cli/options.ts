import { Command, InvalidArgumentError } from "commander";
import {
  OUTPUT_FORMATS,
  type LogLevel,
  type OutputFormat,
} from "../agent/protocol.js";

export type CommandOutputOptions = {
  format?: OutputFormat;
  pretty?: boolean;
  verbose?: boolean;
  logLevel?: LogLevel;
};

export function isOutputFormat(value: unknown): value is OutputFormat {
  return (
    typeof value === "string" && OUTPUT_FORMATS.includes(value as OutputFormat)
  );
}

export function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === "silent" ||
    value === "error" ||
    value === "info" ||
    value === "debug"
  );
}

export function parseOutputFormat(value: string): OutputFormat {
  if (isOutputFormat(value)) {
    return value;
  }
  throw new InvalidArgumentError(`Invalid --format value: ${value}`);
}

export function parseLogLevel(value: string): LogLevel {
  if (isLogLevel(value)) {
    return value;
  }
  throw new InvalidArgumentError(`Invalid --log-level value: ${value}`);
}

function assignOutputOption(
  options: CommandOutputOptions,
  name: "format" | "logLevel",
  value: string | undefined,
): void {
  if (name === "format" && isOutputFormat(value)) {
    options.format = value;
    return;
  }
  if (name === "logLevel" && isLogLevel(value)) {
    options.logLevel = value;
  }
}

export function outputOptionsFromRawArgs(rawArgs: string[]): CommandOutputOptions {
  const options: CommandOutputOptions = {};
  if (rawArgs[0]?.startsWith("--")) return options;

  for (let index = 1; index < rawArgs.length; index++) {
    const arg = rawArgs[index]!;
    if (arg === "--pretty") {
      options.pretty = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg.startsWith("--format=")) {
      assignOutputOption(options, "format", arg.slice("--format=".length));
      continue;
    }
    if (arg === "--format") {
      assignOutputOption(options, "format", rawArgs[index + 1]);
      index++;
      continue;
    }
    if (arg.startsWith("--log-level=")) {
      assignOutputOption(
        options,
        "logLevel",
        arg.slice("--log-level=".length),
      );
      continue;
    }
    if (arg === "--log-level") {
      assignOutputOption(options, "logLevel", rawArgs[index + 1]);
      index++;
    }
  }

  return options;
}

export function parseIntegerOption(name: string, minimum?: number, maximum?: number) {
  return (value: string): string => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== String(value).trim()) {
      throw new InvalidArgumentError(`${name} must be an integer`);
    }
    if (minimum !== undefined && parsed < minimum) {
      throw new InvalidArgumentError(`${name} must be >= ${minimum}`);
    }
    if (maximum !== undefined && parsed > maximum) {
      throw new InvalidArgumentError(`${name} must be <= ${maximum}`);
    }
    return value;
  };
}

export function addOutputOptions<T extends Command>(command: T): T {
  return command
    .option("--format <format>", "output format: text, json, or ndjson", parseOutputFormat)
    .option("--pretty", "pretty-print JSON output")
    .option("--verbose", "include metadata, next actions, and command diagnostics")
    .option("-h, --help", "display command help")
    .option("--log-level <level>", "stderr log level: silent, error, info, or debug", parseLogLevel) as T;
}
