import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHelp } from "../agent/manifest.js";
import {
  removeDirWithRetries,
  restoreEnvSnapshot,
  snapshotEnv,
} from "../testUtils.js";
import { Config, resolveConfigPath } from "../types.js";
import { parseCommandLine } from "./commander.js";
import { getCommandFamily, runCli } from "./main.js";

const withOpenAICodexProviderScope = vi.hoisted(() =>
  vi.fn(<T>(run: () => Promise<T>) => run()),
);

vi.mock("../services/OpenAICodexProvider.js", () => ({
  withOpenAICodexProviderScope,
}));

type CliRun = { exitCode: number; stdout: string; stderr: string };

/** Runs the CLI with stdout (including console.log) and stderr captured instead of leaked. */
async function runCliCaptured(args: string[]): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
  const consoleSpy = vi.spyOn(console, "log").mockImplementation((...values) => {
    stdout += `${values.map(String).join(" ")}\n`;
  });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });

  try {
    const exitCode = await runCli(args);
    return { exitCode, stdout, stderr };
  } finally {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

/** Writes a config with an in-memory database and a library next to the config file. */
function writeConfig(
  configPath: string,
  overrides: Partial<Pick<Config, "models">> = {},
): void {
  const config = {
    ...Config.Default,
    library: { path: join(dirname(configPath), "library") },
    storage: { libsql: { url: ":memory:" } },
    ...overrides,
  };
  writeFileSync(configPath, JSON.stringify(config), "utf-8");
}

/** Reads the persisted format as written, without normalization filling in a default. */
function readConfigFormat(configPath: string): unknown {
  const saved: { cli?: { globalFlags?: { format?: unknown } } } = JSON.parse(
    readFileSync(configPath, "utf-8"),
  );
  return saved.cli?.globalFlags?.format;
}

describe("CLI command family routing", () => {
  test.each([
    [["help"], "lightweight"],
    [["config"], "lightweight"],
    [["stats"], "store"],
    [["page"], "store"],
    [["search", "query"], "search"],
    [["taxonomy"], "search"],
    [["add", "document.pdf"], "ingestion"],
    [["reindex"], "ingestion"],
    [["providers"], "setup"],
    [["doctor"], "diagnostics"],
    [["mcp"], "server"],
    [["providers", "--help", "--format", "json"], "lightweight"],
  ] as const)("%j routes to %s", (args, expected) => {
    expect(getCommandFamily(parseCommandLine([...args]))).toBe(expected);
  });

  test("parses page extraction options without confusing export format and response format", () => {
    const parsed = parseCommandLine([
      "page",
      "extract",
      "abc123",
      "2,5-7",
      "--output-format",
      "pdf,png",
      "--png-width",
      "2000",
      "--format",
      "json",
    ]);

    expect(parsed.args.slice(0, 4)).toEqual([
      "page",
      "extract",
      "abc123",
      "2,5-7",
    ]);
    expect(parsed.options).toMatchObject({
      outputFormat: "pdf,png",
      pngWidth: "2000",
    });
    expect(parsed.globals.format).toBe("json");
  });

  test("parses repeatable ingest file selection options", () => {
    const parsed = parseCommandLine([
      "ingest",
      "./docs",
      "--include",
      "**/*.md",
      "--include",
      "**/*.pdf",
      "--exclude",
      "**/archive/**",
    ]);

    expect(parsed.args.slice(0, 2)).toEqual(["ingest", "./docs"]);
    expect(parsed.options).toMatchObject({
      include: ["**/*.md", "**/*.pdf"],
      exclude: ["**/archive/**"],
    });
  });
});

describe("runCli config selection", () => {
  const originalEnv = snapshotEnv(["POINK_CONFIG"]);
  let directory: string;
  let envConfigPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "poink-main-test-"));
    envConfigPath = join(directory, "env-config.json");
    process.env.POINK_CONFIG = envConfigPath;
  });

  afterEach(async () => {
    restoreEnvSnapshot(originalEnv);
    await removeDirWithRetries(directory);
  });

  test.each([
    ["providers", "--help"],
    ["stats", "--help"],
    ["read", "--help"],
    ["search", "-h"],
    ["taxonomy", "get", "--help"],
  ])("command-scoped help ignores malformed config: %s %s", async (...args) => {
    writeFileSync(envConfigPath, "{invalid");

    expect(await runCliCaptured(args)).toEqual({
      exitCode: 0,
      stdout: `${renderHelp()}\n`,
      stderr: "",
    });
  });

  test("command-scoped --config overrides POINK_CONFIG for load and save", async () => {
    const flagConfigPath = join(directory, "flag-config.json");
    writeConfig(envConfigPath);
    writeConfig(flagConfigPath);

    const setViaFlag = await runCliCaptured([
      "config",
      "set",
      "cli.globalFlags.format",
      "json",
      "--config",
      flagConfigPath,
    ]);
    expect(setViaFlag.exitCode).toBe(0);
    expect(readConfigFormat(flagConfigPath)).toBe("json");
    expect(readConfigFormat(envConfigPath)).toBe("text");
    expect(resolveConfigPath()).toBe(envConfigPath);

    const setViaEnv = await runCliCaptured([
      "config",
      "set",
      "cli.globalFlags.format",
      "ndjson",
    ]);
    expect(setViaEnv.exitCode).toBe(0);
    expect(readConfigFormat(flagConfigPath)).toBe("json");
    expect(readConfigFormat(envConfigPath)).toBe("ndjson");
  });

  test("--config=value selects the invocation config path", async () => {
    const configPath = join(directory, "config.json");
    writeConfig(configPath);

    const run = await runCliCaptured([
      "config",
      "show",
      `--config=${configPath}`,
      "--format",
      "json",
    ]);

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      ok: true,
      result: { configPath },
    });
  });

  test.each([
    [
      "--config without a value fails before command parsing",
      ["config", "show", "--config"],
      "INVALID_ARGS: Missing value for --config\n",
    ],
    [
      "root-level --config remains unsupported",
      ["--config", "config.json", "config", "show"],
      "INVALID_FLAG: error: unknown option '--config'\n",
    ],
  ])("%s", async (_name, args, stderr) => {
    expect(await runCliCaptured(args)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr,
    });
  });

  test("configured Codex one-shot commands run inside a provider scope", async () => {
    writeConfig(envConfigPath, {
      models: {
        ...Config.Default.models,
        enrichment: {
          ...Config.Default.models.enrichment,
          provider: "openai-codex",
          model: "gpt-5.5",
        },
      },
    });
    withOpenAICodexProviderScope.mockClear();

    const run = await runCliCaptured([
      "add",
      join(directory, "missing.md"),
      "--enrich",
    ]);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(/^SOURCE_FILE_UNAVAILABLE:/);
    expect(withOpenAICodexProviderScope).toHaveBeenCalledOnce();
  });
});
