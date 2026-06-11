import { Command, InvalidArgumentError } from "commander";
import { OUTPUT_FORMATS, type LogLevel, type OutputFormat } from "../agent/protocol.js";

export type CommandOutputOptions = {
  format?: OutputFormat;
  pretty?: boolean;
  verbose?: boolean;
  logLevel?: LogLevel;
};

export function parseOutputFormat(value: string): OutputFormat {
  if (OUTPUT_FORMATS.includes(value as OutputFormat)) {
    return value as OutputFormat;
  }
  throw new InvalidArgumentError(`Invalid --format value: ${value}`);
}

export function parseLogLevel(value: string): LogLevel {
  if (value === "silent" || value === "error" || value === "info" || value === "debug") {
    return value;
  }
  throw new InvalidArgumentError(`Invalid --log-level value: ${value}`);
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
