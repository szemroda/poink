import type { Effect } from "effect";
import type { CommandResult } from "../../agent/hints.js";

export type CliConsole = {
  log: (message: string) => Effect.Effect<void, never, never>;
  error: (message: string) => Effect.Effect<void, never, never>;
};

export type CliCommandOutput = {
  resultPayload: unknown;
  agentResult: CommandResult | null;
};
