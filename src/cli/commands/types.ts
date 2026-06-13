import type { Effect } from "effect";
import type { CommandResult } from "../../agent/hints.js";

type CliConsoleWrite = (
  message: string,
) => Effect.Effect<void, never, never>;

export type CliConsole = {
  log: CliConsoleWrite;
  error: CliConsoleWrite;
};

export type CliCommandOutput<ResultPayload = unknown> = {
  resultPayload: ResultPayload;
  agentResult: CommandResult | null;
};
