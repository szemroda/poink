import { Effect } from "effect";
import { runProvidersCommand } from "../commands/providers.js";
import { runSetupCommand } from "../commands/setup.js";
import { CLIError, runCommandWithContext } from "../runner.js";
import { runFamilyEffect } from "./shared.js";
import type { FamilyRunner } from "./types.js";

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
}) => {
  let program;
  if (parsed.args[0] === "providers") {
    program = runCommandWithContext(
      parsed.args,
      globals,
      ({ Console, format }) =>
        runProvidersCommand(
          parsed.args,
          format,
          Console,
          parsed.options,
        ),
      parsed.options,
    );
  } else if (parsed.args[0] === "setup") {
    program = runSetupCommand(parsed.args, globals, parsed.options);
  } else {
    program = Effect.fail(
      new CLIError(
        "UNKNOWN_COMMAND",
        `Unknown setup command: ${parsed.args[0]}`,
      ),
    );
  }
  return runFamilyEffect(program, globals);
};
