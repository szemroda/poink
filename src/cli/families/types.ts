import type { Config } from "../../types.js";
import type { ParsedCommandLine } from "../commander.js";
import type { GlobalCLIOptions } from "../runner.js";

interface FamilyRunnerInput {
  readonly parsed: ParsedCommandLine;
  readonly globals: GlobalCLIOptions;
  readonly config: Config;
}

export type FamilyRunner = (input: FamilyRunnerInput) => Promise<unknown>;
