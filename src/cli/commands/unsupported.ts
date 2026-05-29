import { Effect } from "effect";
import {
  CLIError,
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

interface UnsupportedCommandOptions extends Record<string, unknown> {}

export function runUnsupportedCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: UnsupportedCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ command }) =>
    Effect.fail(
      new CLIError(
        command === "export" || command === "import"
          ? "UNSUPPORTED_COMMAND"
          : "UNKNOWN_COMMAND",
        command === "export" || command === "import"
          ? `${command} has been removed from this fork`
          : `Unknown command: ${command}`,
        command === "export" || command === "import"
          ? {
              command,
              reason:
                "The legacy backup/import flow depended on old repository distribution assumptions and has been intentionally removed during cleanup.",
            }
          : { command },
      ),
    ),
    options);
}
