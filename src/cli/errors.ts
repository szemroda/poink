import type { CommanderError } from "commander";
import { CLIError, describeCliFailure } from "./runner.js";

export { CLIError, describeCliFailure };

export function coerceCliError(error: unknown): CLIError {
  if (error instanceof CLIError) return error;
  const tag =
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    typeof (error as { _tag?: unknown })._tag === "string"
      ? String((error as { _tag: string })._tag)
      : "UNKNOWN_ERROR";
  return new CLIError(tag, describeCliFailure(error), error);
}

export function mapCommanderError(error: CommanderError): CLIError {
  const message = error.message;
  switch (error.code) {
    case "commander.unknownOption":
      return new CLIError("INVALID_FLAG", message, { commanderCode: error.code });
    case "commander.optionMissingArgument":
      return new CLIError("INVALID_ARGS", message, { commanderCode: error.code });
    case "commander.missingArgument":
      return new CLIError("INVALID_ARGS", message, { commanderCode: error.code });
    case "commander.invalidArgument":
      return new CLIError(
        message.includes("option '--format") || message.includes("option '--log-level")
          ? "INVALID_FLAG"
          : "INVALID_ARGS",
        message,
        { commanderCode: error.code },
      );
    case "commander.unknownCommand":
      return new CLIError("UNKNOWN_COMMAND", message, { commanderCode: error.code });
    default:
      return new CLIError("INVALID_ARGS", message, { commanderCode: error.code });
  }
}
