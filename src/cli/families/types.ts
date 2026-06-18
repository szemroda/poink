import type { Config } from "../../types.js";
import type { ParsedCommandLine } from "../commander.js";
import type { GlobalCLIOptions } from "../runner.js";
import type { InvocationTiming } from "../timing.js";

export interface FamilyRunnerInput {
  readonly parsed: ParsedCommandLine;
  readonly globals: GlobalCLIOptions;
  readonly config: Config;
  readonly timing: InvocationTiming;
}

export type FamilyRunner = (input: FamilyRunnerInput) => Promise<unknown>;
