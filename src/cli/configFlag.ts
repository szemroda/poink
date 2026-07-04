import { CLIError } from "./errors.js";

const CONFIG_FLAG = "--config";
const CONFIG_FLAG_ASSIGNMENT_PREFIX = `${CONFIG_FLAG}=`;

export type ConfigFlagSelection = {
  args: string[];
  configPath?: string;
};

function missingConfigValueError(): CLIError {
  return new CLIError("INVALID_ARGS", `Missing value for ${CONFIG_FLAG}`, {
    hint: `Use ${CONFIG_FLAG} <path>.`,
  });
}

function duplicateConfigFlagError(): CLIError {
  return new CLIError(
    "INVALID_ARGS",
    `${CONFIG_FLAG} specified multiple times`,
  );
}

function ensureSingleConfigPath(
  currentPath: string | undefined,
  nextPath: string,
): string {
  if (currentPath !== undefined) {
    throw duplicateConfigFlagError();
  }
  return nextPath;
}

export function normalizeRawArgs(rawArgs: string[]): string[] {
  if (rawArgs.length === 0) return ["--help"];
  if (rawArgs.length === 1 && rawArgs[0] === "-h") return ["--help"];
  if (rawArgs.length === 1 && rawArgs[0] === "-v") return ["--version"];
  return rawArgs;
}

export function extractConfigFlag(rawArgs: string[]): ConfigFlagSelection {
  if (rawArgs[0]?.startsWith("--")) {
    return { args: rawArgs };
  }

  const strippedArgs: string[] = [];
  let configPath: string | undefined;

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]!;
    if (arg.startsWith(CONFIG_FLAG_ASSIGNMENT_PREFIX)) {
      const value = arg.slice(CONFIG_FLAG_ASSIGNMENT_PREFIX.length);
      if (value.length === 0) {
        throw missingConfigValueError();
      }
      configPath = ensureSingleConfigPath(configPath, value);
      continue;
    }

    if (arg === CONFIG_FLAG) {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw missingConfigValueError();
      }
      configPath = ensureSingleConfigPath(configPath, value);
      index++;
      continue;
    }

    strippedArgs.push(arg);
  }

  if (configPath === undefined) return { args: strippedArgs };
  return { args: strippedArgs, configPath };
}
