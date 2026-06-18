import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  createCodexAppServer,
  isAuthenticationError,
  isUnsupportedFeatureError,
  listModels,
  type CodexAppServerProvider,
} from "ai-sdk-provider-codex-cli";
import { type Config, OpenAICodexError } from "../types.js";

export const MIN_CODEX_VERSION = "0.130.0";
const MISSING_RUNTIME_ERROR =
  "Bundled Codex runtime was not found. Reinstall poink so @openai/codex is present.";
const AUTHENTICATION_ERROR =
  "Codex authentication is missing or expired. Run: poink providers login --provider openai-codex";

export type CodexProviderManager = {
  getLanguageModel(modelId: string): LanguageModelV3;
  close(): Promise<void>;
};

export type CodexCommand = {
  command: string;
  args: string[];
};

export type OpenAICodexRuntimeStatus = {
  configured: boolean;
  roles: Array<"enrichment" | "judge">;
  canStart: boolean;
  authenticated: boolean;
  error?: string;
};

function managedCodexPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("@openai/codex/package.json");
    return join(dirname(packageJsonPath), "bin", "codex.js");
  } catch {
    return undefined;
  }
}

function requireManagedCodexPath(): string {
  const path = managedCodexPath();
  if (!path) {
    throw new OpenAICodexError({ reason: MISSING_RUNTIME_ERROR });
  }
  return path;
}

export function getOpenAICodexConfiguredRoles(
  config: Config,
): Array<"enrichment" | "judge"> {
  const roles: Array<"enrichment" | "judge"> = [];
  if (config.models.enrichment.provider === "openai-codex") {
    roles.push("enrichment");
  }
  if (config.models.judge.provider === "openai-codex") {
    roles.push("judge");
  }
  return roles;
}

export function getOpenAICodexRuntimeKey(): string {
  return managedCodexPath() ?? "<missing-bundled-runtime>";
}

export function resolveOpenAICodexCommand(): CodexCommand {
  return { command: process.execPath, args: [requireManagedCodexPath()] };
}

export function buildOpenAICodexLoginCommand(
  options: { deviceAuth?: boolean } = {},
): CodexCommand {
  const base = resolveOpenAICodexCommand();
  return {
    command: base.command,
    args: [
      ...base.args,
      "login",
      ...(options.deviceAuth ? ["--device-auth"] : []),
    ],
  };
}

export async function runOpenAICodexLogin(
  options: { stdio?: "inherit" | "pipe"; deviceAuth?: boolean } = {},
): Promise<void> {
  const login = buildOpenAICodexLoginCommand({
    deviceAuth: options.deviceAuth,
  });
  const stdio = options.stdio ?? "inherit";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(login.command, login.args, {
      stdio,
      env: process.env,
    });

    let stderr = "";
    if (stdio === "pipe") {
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("error", (error) => {
      reject(
        new OpenAICodexError({
          reason: `Could not start Codex login runtime (${login.command}). ${describeOpenAICodexRuntimeError(error)}`,
        }),
      );
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = stderr.trim();
      reject(
        new OpenAICodexError({
          reason:
            `Codex login failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}.` +
            (detail ? ` ${detail}` : ""),
        }),
      );
    });
  });
}

function createManager(): CodexProviderManager {
  let provider: CodexAppServerProvider | null = null;

  const getProvider = (): CodexAppServerProvider => {
    if (provider) {
      return provider;
    }
    provider = createCodexAppServer({
      defaultSettings: {
        codexPath: requireManagedCodexPath(),
        minCodexVersion: MIN_CODEX_VERSION,
        approvalPolicy: "never",
        sandboxPolicy: "read-only",
        personality: "pragmatic",
        logger: false,
      },
    });
    return provider;
  };

  return {
    getLanguageModel: (modelId: string) => {
      try {
        return getProvider().languageModel(modelId);
      } catch (error) {
        throw new OpenAICodexError({
          reason: describeOpenAICodexRuntimeError(error),
        });
      }
    },
    close: async () => {
      const current = provider;
      provider = null;
      if (current) {
        await current.close();
      }
    },
  };
}

type ManagerEntry = {
  readonly manager: CodexProviderManager;
  activeScopes: number;
};

const managerScope = new AsyncLocalStorage<Set<string>>();
const managers = new Map<string, ManagerEntry>();

async function closeManagerEntry(key: string, entry: ManagerEntry): Promise<void> {
  if (managers.get(key) !== entry) {
    return;
  }
  managers.delete(key);
  await entry.manager.close();
}

async function releaseOpenAICodexProviderScope(keys: Set<string>): Promise<void> {
  const closePromises: Promise<void>[] = [];
  for (const key of keys) {
    const entry = managers.get(key);
    if (!entry) continue;
    entry.activeScopes = Math.max(0, entry.activeScopes - 1);
    if (entry.activeScopes === 0) {
      closePromises.push(closeManagerEntry(key, entry));
    }
  }
  await Promise.all(closePromises);
}

export async function withOpenAICodexProviderScope<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const keys = new Set<string>();
  return managerScope.run(keys, async () => {
    try {
      return await fn();
    } finally {
      await releaseOpenAICodexProviderScope(keys);
    }
  });
}

export function getOpenAICodexProviderManager(): CodexProviderManager {
  const key = getOpenAICodexRuntimeKey();
  let entry = managers.get(key);
  if (!entry) {
    entry = { manager: createManager(), activeScopes: 0 };
    managers.set(key, entry);
  }

  const scope = managerScope.getStore();
  if (scope && !scope.has(key)) {
    scope.add(key);
    entry.activeScopes += 1;
  }

  return entry.manager;
}

export async function closeOpenAICodexProviderManager(): Promise<void> {
  const entries = [...managers.entries()];
  managers.clear();
  await Promise.all(entries.map(([, entry]) => entry.manager.close()));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export function describeOpenAICodexRuntimeError(error: unknown): string {
  if (isAuthenticationError(error)) {
    return AUTHENTICATION_ERROR;
  }

  if (isUnsupportedFeatureError(error)) {
    return `Bundled Codex runtime is too old for app-server support. Reinstall poink so @openai/codex is current. Minimum supported version: ${MIN_CODEX_VERSION}.`;
  }

  const message = getErrorMessage(error);

  if (/ENOENT|not found|cannot find|no such file/i.test(message)) {
    return MISSING_RUNTIME_ERROR;
  }

  if (/unauth|login|oauth|forbidden|401|403/i.test(message)) {
    return AUTHENTICATION_ERROR;
  }

  return message;
}

export async function checkOpenAICodexRuntime(
  config: Config,
): Promise<OpenAICodexRuntimeStatus> {
  const roles = getOpenAICodexConfiguredRoles(config);
  const base = {
    configured: roles.length > 0,
    roles,
  };

  if (roles.length === 0) {
    return {
      ...base,
      canStart: false,
      authenticated: false,
    };
  }

  const bundledPath = managedCodexPath();
  if (!bundledPath) {
    return {
      ...base,
      canStart: false,
      authenticated: false,
      error: MISSING_RUNTIME_ERROR,
    };
  }

  try {
    await listModels({
      codexPath: bundledPath,
      minCodexVersion: MIN_CODEX_VERSION,
      connectionTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
    });
    return {
      ...base,
      canStart: true,
      authenticated: true,
    };
  } catch (error) {
    const reason = describeOpenAICodexRuntimeError(error);
    return {
      ...base,
      canStart: !/runtime was not found|too old/i.test(reason),
      authenticated: false,
      error: reason,
    };
  }
}
