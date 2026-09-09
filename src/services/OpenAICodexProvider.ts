import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import {
  accessSync, closeSync, constants, existsSync, openSync, readSync, realpathSync, statSync,
} from "node:fs";
import {
  basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep,
} from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import {
  createCodexAppServer,
  isAuthenticationError,
  listModels,
  type CodexAppServerProvider,
} from "ai-sdk-provider-codex-cli";
import { type Config, expandHomePath, OpenAICodexError } from "../types.js";

const MISSING_RUNTIME_ERROR =
  "Codex was not found on PATH outside Poink's dependencies. Install Codex, or set providers.openai-codex.codexPath or POINK_CODEX_PATH to an absolute file path.";
const AUTHENTICATION_ERROR =
  "Codex authentication is missing or expired. Run: poink providers login --provider openai-codex";

export type CodexProviderManager = {
  getLanguageModel(modelId: string): LanguageModelV4;
  close(): Promise<void>;
};

export type CodexCommand = {
  command: string;
  args: string[];
};

type CodexRuntime = {
  path: string;
  source: "providers.openai-codex.codexPath" | "POINK_CODEX_PATH" | "PATH";
  requestedPath: string;
};

function resolveConfiguredRuntime(
  value: string,
  source: CodexRuntime["source"],
): CodexRuntime {
  let path = expandHomePath(value);
  const fail = (reason: string): never => {
    throw new OpenAICodexError({
      reason: `Codex at "${value}" from ${source}: ${reason}`,
    });
  };
  const fullyQualified = isAbsolute(path)
    && (process.platform !== "win32" || /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(path));
  if (!fullyQualified) {
    fail("Use an absolute file path or a path starting with ~/ or ~\\.");
  }
  try {
    if (!statSync(path).isFile()) fail("The path does not point to a file.");
    path = resolveLauncher(realpathSync(path));
    if (!statSync(path).isFile()) fail("The launcher does not point to a file.");
    accessSync(path, /\.[cm]?js$/i.test(path) ? constants.R_OK : constants.X_OK);
  } catch (error) {
    if (error instanceof OpenAICodexError) throw error;
    fail(`Could not use this file. ${getErrorMessage(error)}`);
  }
  return { path, source, requestedPath: value };
}

function resolveRuntime(config: Config): CodexRuntime {
  const configured = config.providers["openai-codex"].codexPath;
  if (configured?.trim()) {
    return resolveConfiguredRuntime(configured, "providers.openai-codex.codexPath");
  }
  const environment = process.env.POINK_CODEX_PATH;
  if (environment?.trim()) return resolveConfiguredRuntime(environment, "POINK_CODEX_PATH");
  const dependencyDirectories = codexDependencyDirectories();
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.toLowerCase())
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory.replace(/^"(.*)"$/, "$1"), `codex${extension}`);
      if (!isExecutableFile(candidate)) continue;
      const runtime = resolveConfiguredRuntime(candidate, "PATH");
      if (dependencyDirectories.some((directory) => isWithinDirectory(runtime.path, directory))) {
        continue;
      }
      return runtime;
    }
  }
  throw new OpenAICodexError({ reason: MISSING_RUNTIME_ERROR });
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// npm's Windows launchers cannot be spawned by the adapter. Resolve their
// standard Codex entry point without evaluating shell commands.
function resolveLauncher(path: string): string {
  const extension = extname(path).toLowerCase();
  if (![".cmd", ".ps1", ".bat"].includes(extension) && basename(path) !== "codex") return path;
  const fd = openSync(path, "r");
  let header: string;
  try {
    const buffer = Buffer.alloc(8192);
    header = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
  } finally {
    closeSync(fd);
  }
  const target = header.match(/(?:%dp0%|\$basedir)[\\/]((?:node_modules|\.\.)[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js)/i)?.[1];
  if (target) return realpathSync(resolve(dirname(path), ...target.split(/[\\/]/)));
  if ([".cmd", ".ps1", ".bat"].includes(extension)) {
    throw new Error("Unsupported launcher. Select the Codex executable or its bin/codex.js file.");
  }
  return path;
}

function codexDependencyDirectories(): string[] {
  const require = createRequire(import.meta.url);
  const adapterManifest = require.resolve("ai-sdk-provider-codex-cli/package.json");
  const adapterRequire = createRequire(adapterManifest);
  let dependencyRoot = dirname(adapterManifest);
  while (basename(dependencyRoot) !== "node_modules") {
    const parent = dirname(dependencyRoot);
    if (parent === dependencyRoot) return [];
    dependencyRoot = parent;
  }

  // Stop at the adapter's dependency tree. Ancestor global packages may be
  // separate user installations; hoisted npx dependencies remain inside it.
  const directories: string[] = [];
  for (const lookup of adapterRequire.resolve.paths("@openai/codex") ?? []) {
    if (!isWithinDirectory(lookup, dependencyRoot)) continue;
    for (const name of ["codex", `codex-${process.platform}-${process.arch}`]) {
      const directory = join(lookup, "@openai", name);
      if (existsSync(directory)) directories.push(realpathSync(directory));
    }
  }
  return directories;
}

function isWithinDirectory(path: string, directory: string): boolean {
  const fromDirectory = relative(directory, path);
  return !isAbsolute(fromDirectory)
    && fromDirectory !== ".."
    && !fromDirectory.startsWith(`..${sep}`);
}

export type OpenAICodexRuntimeStatus = {
  configured: boolean;
  roles: Array<"enrichment" | "judge">;
  canStart: boolean;
  authenticated: boolean;
  error?: string;
  path?: string;
  source?: CodexRuntime["source"];
};

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

export function resolveOpenAICodexCommand(config: Config): CodexCommand {
  return runtimeCommand(resolveRuntime(config));
}

function runtimeCommand({ path }: CodexRuntime): CodexCommand {
  return /\.[cm]?js$/i.test(path)
    ? { command: process.execPath, args: [path] }
    : { command: path, args: [] };
}

export function buildOpenAICodexLoginCommand(
  config: Config,
  options: { deviceAuth?: boolean } = {},
): CodexCommand {
  const base = resolveOpenAICodexCommand(config);
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
  config: Config,
  options: { stdio?: "inherit" | "pipe"; deviceAuth?: boolean } = {},
): Promise<void> {
  const runtime = resolveRuntime(config);
  const base = runtimeCommand(runtime);
  const login = {
    command: base.command,
    args: [...base.args, "login", ...(options.deviceAuth ? ["--device-auth"] : [])],
  };
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
      reject(codexRuntimeError(error, runtime));
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = stderr.trim();
      reject(
        new OpenAICodexError({
          kind: signal ? "runtime" : "authentication",
          reason:
            `${describeRuntime(runtime)}: Codex login failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}.` +
            (detail ? ` ${detail}` : ""),
        }),
      );
    });
  });
}

function createManager(runtime: CodexRuntime): CodexProviderManager {
  let provider: CodexAppServerProvider | null = null;

  const getProvider = (): CodexAppServerProvider => {
    if (provider) {
      return provider;
    }
    provider = createCodexAppServer({
      defaultSettings: {
        codexPath: runtime.path,
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
        return wrapLanguageModel({
          model: getProvider().languageModel(modelId),
          middleware: {
            specificationVersion: "v4",
            wrapGenerate: async ({ doGenerate }) => {
              try {
                return await doGenerate();
              } catch (error) {
                throw codexRuntimeError(error, runtime);
              }
            },
            wrapStream: async ({ doStream }) => {
              try {
                return await doStream();
              } catch (error) {
                throw codexRuntimeError(error, runtime);
              }
            },
          },
        });
      } catch (error) {
        throw codexRuntimeError(error, runtime);
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

export function getOpenAICodexProviderManager(config: Config): CodexProviderManager {
  const runtime = resolveRuntime(config);
  const key = JSON.stringify(runtime);
  let entry = managers.get(key);
  if (!entry) {
    entry = { manager: createManager(runtime), activeScopes: 0 };
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
  return codexRuntimeError(error).reason;
}

function codexRuntimeError(error: unknown, runtime?: CodexRuntime): OpenAICodexError {
  if (error instanceof OpenAICodexError) return error;
  const message = getErrorMessage(error);
  const authentication = isAuthenticationError(error) || /unauthorized|not authenticated|authentication|oauth|forbidden|\b401\b|\b403\b/i.test(message);
  let reason = authentication ? AUTHENTICATION_ERROR : message;
  // The adapter exposes version rejections as plain Errors, without a code.
  if (/codex app-server version .+ is below required minimum|codex app-server requires codex CLI >=/i.test(message)) {
    reason = `${message} Update Codex at the selected path, or configure a compatible installation.`;
  }
  if (runtime) {
    reason = `${describeRuntime(runtime)}: ${reason}`;
  }
  return new OpenAICodexError({ reason, kind: authentication ? "authentication" : "runtime" });
}

function describeRuntime(runtime: CodexRuntime): string {
  const selected = runtime.requestedPath === runtime.path ? "" : `, selected as "${runtime.requestedPath}"`;
  return `Codex at "${runtime.path}" from ${runtime.source}${selected}`;
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

  let runtime: CodexRuntime;
  try {
    runtime = resolveRuntime(config);
  } catch (error) {
    return {
      ...base,
      canStart: false,
      authenticated: false,
      error: describeOpenAICodexRuntimeError(error),
    };
  }

  try {
    await listModels({
      codexPath: runtime.path,
      connectionTimeoutMs: 15_000,
      requestTimeoutMs: 15_000,
    });
    return {
      ...base,
      canStart: true,
      authenticated: true,
      path: runtime.path,
      source: runtime.source,
    };
  } catch (error) {
    const failure = codexRuntimeError(error, runtime);
    return {
      ...base,
      canStart: failure.kind === "authentication",
      authenticated: false,
      error: failure.reason,
      path: runtime.path,
      source: runtime.source,
    };
  }
}
