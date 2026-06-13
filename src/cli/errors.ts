import type { CommanderError } from "commander";
import { CLIError, describeCliFailure } from "./runner.js";

export { CLIError, describeCliFailure };

const INVALID_FLAG_ARGUMENT_PREFIXES = [
  "option '--format",
  "option '--log-level",
];

function errorTag(error: unknown): string {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    typeof error._tag !== "string"
  ) {
    return "UNKNOWN_ERROR";
  }

  return error._tag;
}

export function coerceCliError(error: unknown): CLIError {
  if (error instanceof CLIError) return error;

  return new CLIError(errorTag(error), describeCliFailure(error), error);
}

function isInvalidFlagArgument(message: string): boolean {
  return INVALID_FLAG_ARGUMENT_PREFIXES.some((prefix) =>
    message.includes(prefix),
  );
}

function commanderErrorCode(error: CommanderError): string {
  if (error.code === "commander.unknownOption") return "INVALID_FLAG";
  if (error.code === "commander.unknownCommand") return "UNKNOWN_COMMAND";
  if (
    error.code === "commander.invalidArgument" &&
    isInvalidFlagArgument(error.message)
  ) {
    return "INVALID_FLAG";
  }

  return "INVALID_ARGS";
}

export function mapCommanderError(error: CommanderError): CLIError {
  return new CLIError(commanderErrorCode(error), error.message, {
    commanderCode: error.code,
  });
}
