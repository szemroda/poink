import { runProvidersCommand } from "../commands/providers.js";
import { runSetupCommand } from "../commands/setup.js";
import {
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";
import {
  commandHandlers,
  runFamilyEffect,
  runResolvedFamilyCommand,
} from "./shared.js";
import type { FamilyRunner } from "./types.js";

function runProvidersWithContext(
  args: string[],
  globals: GlobalCLIOptions,
  options: Record<string, unknown>,
) {
  return runCommandWithContext(
    args,
    globals,
    ({ Console, format }) =>
      runProvidersCommand(
        args,
        format,
        Console,
        options,
      ),
    options,
  );
}

const COMMAND_HANDLERS = commandHandlers([
  ["providers", runProvidersWithContext],
  ["setup", runSetupCommand],
]);

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
}) => {
  const program = runResolvedFamilyCommand(
    "setup",
    COMMAND_HANDLERS,
    parsed.args,
    globals,
    parsed.options,
  );
  return runFamilyEffect(program, globals);
};
