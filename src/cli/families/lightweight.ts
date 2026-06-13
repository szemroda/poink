import { Effect } from "effect";
import { renderHelp } from "../../agent/manifest.js";
import { runCapabilitiesCommand } from "../commands/capabilities.js";
import { runConfigCommand } from "../commands/config.js";
import {
  CLIError,
  type GlobalCLIOptions,
  runCommandWithContext,
  VERSION,
} from "../runner.js";
import { runFamilyEffect } from "./shared.js";
import type { FamilyRunner } from "./types.js";

function requestsHelp(args: string[]): boolean {
  return args[0] === "help" || args.includes("--help") || args.includes("-h");
}

function requestsVersion(args: string[]): boolean {
  return (
    args[0] === "version" || args.includes("--version") || args.includes("-v")
  );
}

function runHelp(args: string[], globals: GlobalCLIOptions) {
  return runCommandWithContext(args, globals, ({ Console, format }) =>
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
}

function runVersion(args: string[], globals: GlobalCLIOptions) {
  return runCommandWithContext(args, globals, ({ Console, format }) =>
    Effect.gen(function* () {
      if (format === "text") yield* Console.log(`poink v${VERSION}`);
      return {
        command: "version",
        resultPayload: format === "text" ? null : { version: VERSION },
        agentResult: null,
      };
    }),
  );
}

export const runFamily: FamilyRunner = async ({ parsed, globals, config }) => {
  const { args, options } = parsed;
  if (requestsHelp(args)) {
    return runFamilyEffect(runHelp(args, globals), globals);
  }

  if (requestsVersion(args)) {
    return runFamilyEffect(runVersion(args, globals), globals);
  }

  const command = args[0];
  if (command === "capabilities") {
    return runFamilyEffect(
      runCapabilitiesCommand(args, globals, options),
      globals,
    );
  }

  if (command === "config") {
    const program = runCommandWithContext(
      args,
      globals,
      ({ Console }) => runConfigCommand(args, Console, config),
      options,
    );
    return runFamilyEffect(program, globals);
  }

  return runFamilyEffect(
    Effect.fail(
      new CLIError("UNKNOWN_COMMAND", `Unknown command: ${command ?? "cli"}`),
    ),
    globals,
  );
};
