import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { removeDirWithRetries } from "../testUtils.js";
import { Config, resolveConfigPath } from "../types.js";
import { parseCommandLine } from "./commander.js";
import { getCommandFamily, runCli } from "./main.js";

const withOpenAICodexProviderScope = vi.hoisted(() =>
  vi.fn(<T>(run: () => Promise<T>) => run()),
);

vi.mock("../services/OpenAICodexProvider.js", () => ({
  withOpenAICodexProviderScope,
}));

type CliDefaultFormat = Config["cli"]["globalFlags"]["format"];

async function withConfigFile(
  contents: string,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "poink-main-test-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, contents);

  try {
    await withPoinkConfigPath(configPath, () => run(directory));
  } finally {
    await removeDirWithRetries(directory);
  }
}

async function withPoinkConfigPath(
  configPath: string,
  run: () => Promise<void>,
): Promise<void> {
  const previousConfigPath = process.env.POINK_CONFIG;
  process.env.POINK_CONFIG = configPath;

  try {
    await run();
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.POINK_CONFIG;
    } else {
      process.env.POINK_CONFIG = previousConfigPath;
    }
  }
}

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "poink-main-test-"));
  try {
    await run(directory);
  } finally {
    await removeDirWithRetries(directory);
  }
}

function makeMainTestConfig(
  libraryPath: string,
  format: CliDefaultFormat = "text",
) {
  return {
    ...Config.Default,
    library: { ...Config.Default.library, path: libraryPath },
    storage: {
      ...Config.Default.storage,
      libsql: { ...Config.Default.storage.libsql, url: ":memory:" },
    },
    cli: {
      ...Config.Default.cli,
      globalFlags: { ...Config.Default.cli.globalFlags, format },
    },
  };
}

function writeMainTestConfig(
  configPath: string,
  libraryPath: string,
  format: CliDefaultFormat = "text",
): void {
  writeFileSync(
    configPath,
    JSON.stringify(makeMainTestConfig(libraryPath, format)),
    "utf-8",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFormat(
  configPath: string,
): CliDefaultFormat | undefined {
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
  if (!isRecord(parsed)) return undefined;
  const cli = parsed.cli;
  if (!isRecord(cli)) return undefined;
  const globalFlags = cli.globalFlags;
  if (!isRecord(globalFlags)) return undefined;
  const format = globalFlags.format;
  if (format !== "text" && format !== "json" && format !== "ndjson") {
    return undefined;
  }
  return format;
}

function expectConfigFormat(
  configPath: string,
  expectedFormat: CliDefaultFormat,
): void {
  expect(readConfigFormat(configPath)).toBe(expectedFormat);
}

describe("CLI command family routing", () => {
  test.each([
    ["help", "lightweight"],
    ["config", "lightweight"],
    ["stats", "store"],
    ["page", "store"],
    ["search", "search"],
    ["taxonomy", "search"],
    ["add", "ingestion"],
    ["reindex", "ingestion"],
    ["providers", "setup"],
    ["doctor", "diagnostics"],
    ["mcp", "server"],
  ] as const)("%s routes to %s", (command, expected) => {
    const args =
      command === "search"
        ? ["search", "query"]
        : command === "add"
          ? ["add", "document.pdf"]
          : [command];
    expect(getCommandFamily(parseCommandLine(args))).toBe(expected);
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
    expect(parsed.options.outputFormat).toBe("pdf,png");
    expect(parsed.options.pngWidth).toBe("2000");
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
      "--format",
      "json",
    ]);

    expect(parsed.args.slice(0, 2)).toEqual(["ingest", "./docs"]);
    expect(parsed.options.include).toEqual(["**/*.md", "**/*.pdf"]);
    expect(parsed.options.exclude).toEqual(["**/archive/**"]);
    expect(parsed.globals.format).toBe("json");
  });

  test("command help always uses the lightweight family", () => {
    expect(
      getCommandFamily(
        parseCommandLine(["providers", "--help", "--format", "json"]),
      ),
    ).toBe("lightweight");
  });

  test.each(["export", "import"])(
    "obsolete %s command is not registered",
    (command) => {
      expect(() => parseCommandLine([command])).toThrow(/unknown command/i);
    },
  );

  test.each([
    ["providers", "--help"],
    ["stats", "--help"],
  ])(
    "command-scoped help ignores malformed config: %s %s",
    async (...args) => {
      await withConfigFile("{invalid", async () => {
        expect(await runCli(args)).toBe(0);
      });
    },
  );

  test("command-scoped --config overrides POINK_CONFIG for load and save", async () => {
    await withTempDirectory(async (directory) => {
      const envConfigPath = join(directory, "env-config.json");
      const flagConfigPath = join(directory, "flag-config.json");
      writeMainTestConfig(envConfigPath, join(directory, "env-library"), "text");
      writeMainTestConfig(flagConfigPath, join(directory, "flag-library"), "text");

      await withPoinkConfigPath(envConfigPath, async () => {
        expect(
          await runCli([
            "config",
            "set",
            "cli.globalFlags.format",
            "json",
            "--config",
            flagConfigPath,
          ]),
        ).toBe(0);

        expectConfigFormat(flagConfigPath, "json");
        expectConfigFormat(envConfigPath, "text");
        expect(resolveConfigPath()).toBe(envConfigPath);

        expect(
          await runCli([
            "config",
            "set",
            "cli.globalFlags.format",
            "ndjson",
          ]),
        ).toBe(0);

        expectConfigFormat(flagConfigPath, "json");
        expectConfigFormat(envConfigPath, "ndjson");
      });
    });
  });

  test("--config=value selects the invocation config path", async () => {
    await withTempDirectory(async (directory) => {
      const configPath = join(directory, "config.json");
      writeMainTestConfig(configPath, join(directory, "library"));

      expect(
        await runCli([
          "config",
          "show",
          `--config=${configPath}`,
          "--format",
          "json",
        ]),
      ).toBe(0);
    });
  });

  test("--config without a value fails before command parsing", async () => {
    expect(await runCli(["config", "show", "--config"])).toBe(1);
  });

  test("root-level --config remains unsupported", async () => {
    await withTempDirectory(async (directory) => {
      const configPath = join(directory, "config.json");
      writeMainTestConfig(configPath, join(directory, "library"));

      expect(await runCli(["--config", configPath, "config", "show"])).toBe(1);
    });
  });

  test("configured Codex one-shot commands run inside a provider scope", async () => {
    await withConfigFile("", async (directory) => {
      const config = {
        ...Config.Default,
        library: { path: directory },
        storage: {
          libsql: { url: ":memory:" },
        },
        models: {
          ...Config.Default.models,
          enrichment: {
            ...Config.Default.models.enrichment,
            provider: "openai-codex",
            model: "gpt-5.5",
          },
        },
      };
      writeFileSync(process.env.POINK_CONFIG!, JSON.stringify(config));
      withOpenAICodexProviderScope.mockClear();
      expect(
        await runCli(["add", join(directory, "missing.md"), "--enrich"]),
      ).toBe(1);
      expect(withOpenAICodexProviderScope).toHaveBeenCalledOnce();
    });
  });
});
