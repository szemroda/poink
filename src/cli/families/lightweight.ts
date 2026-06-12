import { Effect } from "effect";
import { renderHelp } from "../../agent/manifest.js";
import { runCapabilitiesCommand } from "../commands/capabilities.js";
import { runConfigCommand } from "../commands/config.js";
import {
  CLIError,
  runCommandWithContext,
  VERSION,
} from "../runner.js";
import { runFamilyEffect } from "./shared.js";
import type { FamilyRunner } from "./types.js";

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const { args, options } = parsed;
  const command = args[0];
  let program;

  if (
    command === "--help" ||
    command === "help" ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    program = runCommandWithContext(args, globals, ({ Console, format }) =>
      Effect.gen(function* () {
        const help = renderHelp();
        if (format === "text") yield* Console.log(help);
        return {
          command: "help",
          resultPayload: format === "text" ? null : { help },
          agentResult: null,
        };
      }),
    );
  } else if (
    command === "--version" ||
    command === "version" ||
    args.includes("--version") ||
    args.includes("-v")
  ) {
    program = runCommandWithContext(args, globals, ({ Console, format }) =>
      Effect.gen(function* () {
        if (format === "text") yield* Console.log(`poink v${VERSION}`);
        return {
          command: "version",
          resultPayload: format === "text" ? null : { version: VERSION },
          agentResult: null,
        };
      }),
    );
  } else if (command === "capabilities") {
    program = runCapabilitiesCommand(args, globals, options);
  } else if (command === "config") {
    program = runCommandWithContext(
      args,
      globals,
      ({ Console }) => runConfigCommand(args, Console, config),
      options,
    );
  } else {
    program = Effect.fail(
      new CLIError("UNKNOWN_COMMAND", `Unknown command: ${command ?? "cli"}`),
    );
  }

  return runFamilyEffect(program, globals);
};
