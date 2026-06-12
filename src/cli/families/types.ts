import type { Config } from "../../types.js";
import type { ParsedCommandLine } from "../commander.js";
import type { GlobalCLIOptions } from "../runner.js";
import type { InvocationTiming } from "../timing.js";

export type FamilyRunnerInput = {
  parsed: ParsedCommandLine;
  globals: GlobalCLIOptions;
  config: Config;
  timing: InvocationTiming;
};

export type FamilyRunner = (input: FamilyRunnerInput) => Promise<unknown>;
