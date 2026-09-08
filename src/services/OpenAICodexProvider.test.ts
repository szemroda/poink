import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { removeDirWithRetries } from "../testUtils.js";
import { generateText } from "ai";
import { Effect } from "effect";
import { runProvidersCommand } from "../cli/commands/providers.js";
import { getConfiguredLanguageModel } from "./AIProvider.js";
import { Config, normalizeConfig } from "../types.js";
import {
  buildOpenAICodexLoginCommand,
  checkOpenAICodexRuntime,
  closeOpenAICodexProviderManager,
  getOpenAICodexConfiguredRoles,
  getOpenAICodexProviderManager,
  resolveOpenAICodexCommand,
  runOpenAICodexLogin,
  withOpenAICodexProviderScope,
} from "./OpenAICodexProvider.js";

vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return { ...original, createRequire: vi.fn(original.createRequire) };
});

function makeTestConfig(overrides: Record<string, unknown>) {
  const { models, providers, ...rest } = overrides;
  return normalizeConfig({
    ...JSON.parse(JSON.stringify(Config.Default)),
    ...rest,
    models: {
      ...JSON.parse(JSON.stringify(Config.Default.models)),
      ...(models as Record<string, unknown> | undefined),
    },
    providers: {
      ...JSON.parse(JSON.stringify(Config.Default.providers)),
      ...(providers as Record<string, unknown> | undefined),
    },
  });
}

let tempDir: string;
let config: Config;

function writeCodexServer(version: string): Config {
  const codexPath = join(tempDir, "codex.cjs");
  writeFileSync(codexPath, `
    if (process.argv.includes('login')) process.exit(0);
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === 'initialize'
        ? { userAgent: 'codex/${version}' }
        : { data: [], nextCursor: null };
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
    });
  `);
  return makeTestConfig({
    providers: { "openai-codex": { codexPath } },
    models: { enrichment: { provider: "openai-codex", model: "gpt-5.5" } },
  });
}

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), "poink-codex-")));
  const codexPath = join(tempDir, "codex.js");
  writeFileSync(codexPath, "process.exit(0);\n");
  config = makeTestConfig({ providers: { "openai-codex": { codexPath } } });
  vi.stubEnv("POINK_CODEX_PATH", "");
});

afterEach(async () => {
  await closeOpenAICodexProviderManager();
  vi.unstubAllEnvs();
  vi.mocked(createRequire).mockClear();
  await removeDirWithRetries(tempDir);
});

describe("OpenAICodexProvider", () => {
  test("reports configured language roles", () => {
    const config = makeTestConfig({
      models: {
        enrichment: { provider: "openai-codex", model: "gpt-5.5" },
        judge: { provider: "openai-codex", model: "gpt-5.5" },
      },
    });

    expect(getOpenAICodexConfiguredRoles(config)).toEqual([
      "enrichment",
      "judge",
    ]);
  });

  test("uses the configured file for login before the environment setting", () => {
    vi.stubEnv("POINK_CODEX_PATH", join(tempDir, "missing.js"));
    expect(resolveOpenAICodexCommand(config)).toEqual({
      command: process.execPath,
      args: [join(tempDir, "codex.js")],
    });
    expect(buildOpenAICodexLoginCommand(config, { deviceAuth: true })).toEqual({
      command: process.execPath,
      args: [join(tempDir, "codex.js"), "login", "--device-auth"],
    });
  });

  test.each([undefined, "", " \t\n "])("uses the environment file when config is empty (%j)", (codexPath) => {
    vi.stubEnv("POINK_CODEX_PATH", join(tempDir, "codex.js"));
    const emptyConfig = makeTestConfig({ providers: { "openai-codex": { codexPath } } });
    expect(resolveOpenAICodexCommand(emptyConfig)).toEqual({
      command: process.execPath,
      args: [join(tempDir, "codex.js")],
    });
  });

  test.each(["relative/codex.js", "~/missing.js", "directory", "missing.js"])("rejects an invalid configured file without falling back (%s)", (value) => {
    const codexPath = value === "directory" ? tempDir : value === "missing.js" ? join(tempDir, value) : value;
    vi.stubEnv("POINK_CODEX_PATH", join(tempDir, "codex.js"));
    const invalid = makeTestConfig({ providers: { "openai-codex": { codexPath } } });
    expect(() => resolveOpenAICodexCommand(invalid)).toThrow(/providers.openai-codex.codexPath/);
    expect(() => resolveOpenAICodexCommand(invalid)).toThrow(codexPath);
  });

  test.each(["", " \t "])("finds a separate installation on PATH when both settings are empty (%j)", (empty) => {
    const executable = join(tempDir, process.platform === "win32" ? "codex.exe" : "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    vi.stubEnv("POINK_CODEX_PATH", empty);
    vi.stubEnv("PATH", [
      join(process.cwd(), "node_modules", ".bin"),
      join(process.cwd(), "node_modules", "ai-sdk-provider-codex-cli", "node_modules", ".bin"),
      tempDir,
    ].join(delimiter));
    const automatic = makeTestConfig({ providers: { "openai-codex": { codexPath: empty } } });
    expect(resolveOpenAICodexCommand(automatic)).toEqual({ command: executable, args: [] });
  });

  test("reports a missing installation when PATH contains only Poink's dependencies", () => {
    vi.stubEnv("PATH", [
      join(process.cwd(), "node_modules", ".bin"),
      join(process.cwd(), "node_modules", "ai-sdk-provider-codex-cli", "node_modules", ".bin"),
    ].join(delimiter));
    expect(() => resolveOpenAICodexCommand(makeTestConfig({}))).toThrow(/Codex was not found on PATH/);
  });

  test("skips a directory named codex before a valid program on PATH", () => {
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    const unusable = join(tempDir, "unusable");
    mkdirSync(join(unusable, name), { recursive: true });
    const executable = join(tempDir, name);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    vi.stubEnv("PATH", [unusable, tempDir].join(delimiter));
    expect(resolveOpenAICodexCommand(makeTestConfig({}))).toEqual({ command: executable, args: [] });
  });

  test.skipIf(process.platform === "win32")("skips a non-executable file before a runnable Codex on PATH", () => {
    const unusable = join(tempDir, "unusable");
    mkdirSync(unusable);
    writeFileSync(join(unusable, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const executable = join(tempDir, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("PATH", [unusable, tempDir].join(delimiter));
    expect(resolveOpenAICodexCommand(makeTestConfig({}))).toEqual({ command: executable, args: [] });
  });

  test("finds a separately installed global npm Codex alongside a global Poink", () => {
    const globalDir = join(tempDir, "global");
    const modules = join(globalDir, "node_modules");
    const adapter = join(modules, "poink-cli", "node_modules", "ai-sdk-provider-codex-cli");
    mkdirSync(adapter, { recursive: true });
    writeFileSync(join(adapter, "package.json"), JSON.stringify({ name: "ai-sdk-provider-codex-cli", main: "index.js" }));
    writeFileSync(join(adapter, "index.js"), "");
    const codexDir = join(modules, "@openai", "codex");
    mkdirSync(join(codexDir, "bin"), { recursive: true });
    writeFileSync(join(codexDir, "package.json"), JSON.stringify({ name: "@openai/codex" }));
    const entry = join(codexDir, "bin", "codex.js");
    writeFileSync(entry, "process.exit(0);\n");
    const launcher = join(globalDir, process.platform === "win32" ? "codex.cmd" : "codex");
    writeFileSync(launcher, process.platform === "win32"
      ? '@ECHO off\n"node" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n'
      : '#!/bin/sh\nexec node "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\n');
    chmodSync(launcher, 0o755);
    vi.stubEnv("PATH", globalDir);
    const installedRequire = createRequire(join(modules, "poink-cli", "dist", "services", "OpenAICodexProvider.js"));
    vi.mocked(createRequire).mockReturnValueOnce(installedRequire);
    expect(resolveOpenAICodexCommand(makeTestConfig({}))).toEqual({ command: process.execPath, args: [entry] });
  });

  test.each(["config", "env"])("expands the home directory in the %s setting and preserves spaces", (source) => {
    const directory = join(tempDir, "my tools");
    mkdirSync(directory);
    const file = join(directory, "codex.js");
    writeFileSync(file, "process.exit(0);\n");
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("USERPROFILE", tempDir);
    const homePath = process.platform === "win32" ? "~\\my tools\\codex.js" : "~/my tools/codex.js";
    vi.stubEnv("POINK_CODEX_PATH", source === "env" ? homePath : "");
    const selected = makeTestConfig({ providers: { "openai-codex": { codexPath: source === "config" ? homePath : "" } } });
    expect(resolveOpenAICodexCommand(selected)).toEqual({ command: process.execPath, args: [file] });
  });

  test.each(["cmd", "ps1"])("runs the entry point of a standard npm .%s launcher", async (extension) => {
    const entryDir = join(tempDir, "node_modules", "@openai", "codex", "bin");
    mkdirSync(entryDir, { recursive: true });
    const entry = join(entryDir, "codex.js");
    writeFileSync(entry, "process.exit(process.argv.slice(2).join(' ') === 'login --device-auth' ? 0 : 1);\n");
    const launcher = join(tempDir, `codex.${extension}`);
    writeFileSync(launcher, extension === "cmd"
      ? '@ECHO off\n"node" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n'
      : '#!/usr/bin/env pwsh\n& "node" "$basedir/node_modules/@openai/codex/bin/codex.js" $args\n');
    const selected = makeTestConfig({ providers: { "openai-codex": { codexPath: launcher } } });
    await expect(runOpenAICodexLogin(selected, { stdio: "pipe", deviceAuth: true })).resolves.toBeUndefined();
  });

  test("login does not require app-server compatibility", async () => {
    await expect(runOpenAICodexLogin(writeCodexServer("0.0.1"), { stdio: "pipe" })).resolves.toBeUndefined();
  });

  test("doctor ignores invalid Codex settings when another provider is selected", async () => {
    const unused = makeTestConfig({ providers: { "openai-codex": { codexPath: "relative/missing" } } });
    expect(await checkOpenAICodexRuntime(unused)).toEqual({
      configured: false, roles: [], canStart: false, authenticated: false,
    });
  });

  test("doctor accepts an installation whose version is accepted by the adapter", async () => {
    expect(await checkOpenAICodexRuntime(writeCodexServer("99.0.0"))).toMatchObject({
      configured: true, canStart: true, authenticated: true,
      path: join(tempDir, "codex.cjs"), source: "providers.openai-codex.codexPath",
    });
  });

  test("doctor explains an adapter version rejection with the selected path and source", async () => {
    const oldCodex = writeCodexServer("0.0.1");
    const status = await checkOpenAICodexRuntime(oldCodex);
    expect(status.canStart).toBe(false);
    expect(status.error).toContain("0.0.1");
    expect(status.error).toContain("minimum");
    expect(status.error).toContain("Update Codex");
    expect(status.error).toContain(join(tempDir, "codex.cjs"));
    expect(status.error).toContain("providers.openai-codex.codexPath");
  });

  test.each(["generate", "stream"])("%s surfaces the adapter version rejection with actionable runtime context", async (mode) => {
    const oldCodex = writeCodexServer("0.0.1");
    const { model } = await getConfiguredLanguageModel(oldCodex, "enrichment");
    const result = mode === "generate"
      ? generateText({ model, prompt: "Hello", maxRetries: 0 })
      : model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] });
    await expect(result).rejects.toMatchObject({
      kind: "runtime",
      message: expect.stringContaining("Update Codex"),
      reason: expect.stringContaining(join(tempDir, "codex.cjs")),
    });
  });

  test("login reports a missing runtime separately from an authentication failure", async () => {
    const codexPath = join(tempDir, "missing.js");
    const missing = makeTestConfig({ providers: { "openai-codex": { codexPath } } });
    const result = await Effect.runPromise(Effect.either(runProvidersCommand(
      ["providers", "login"], "text", { log: () => Effect.void, error: () => Effect.void },
      { provider: "openai-codex" }, missing,
    )));
    expect(result).toMatchObject({
      _tag: "Left",
      left: { code: "CODEX_RUNTIME_ERROR", message: expect.stringContaining(codexPath) },
    });
  });

  test("login preserves authentication failures and identifies the selected installation", async () => {
    writeFileSync(join(tempDir, "codex.js"), "process.stderr.write('Authorization denied'); process.exit(1);\n");
    await expect(runOpenAICodexLogin(config, { stdio: "pipe" })).rejects.toMatchObject({
      kind: "authentication",
      reason: expect.stringContaining("Authorization denied"),
      message: expect.stringContaining("providers.openai-codex.codexPath"),
    });
  });

  test("keeps a shared manager alive until all overlapping scopes finish", async () => {
    let releaseFirstScope!: () => void;
    let firstScopeReady!: () => void;
    const firstScopeStarted = new Promise<void>((resolve) => {
      firstScopeReady = resolve;
    });

    let firstManager: ReturnType<typeof getOpenAICodexProviderManager> | undefined;
    const firstScope = withOpenAICodexProviderScope(async () => {
      firstManager = getOpenAICodexProviderManager(config);
      firstScopeReady();
      await new Promise<void>((resolve) => {
        releaseFirstScope = resolve;
      });
    });

    try {
      await firstScopeStarted;

      await withOpenAICodexProviderScope(async () => {
        expect(getOpenAICodexProviderManager(config)).toBe(firstManager);
      });

      expect(getOpenAICodexProviderManager(config)).toBe(firstManager);
    } finally {
      releaseFirstScope();
      await firstScope;
    }

    expect(getOpenAICodexProviderManager(config)).not.toBe(firstManager);
  });
});
