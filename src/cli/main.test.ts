import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { removeDirWithRetries } from "../testUtils.js";
import { Config } from "../types.js";
import { parseCommandLine } from "./commander.js";
import { getCommandFamily, runCli } from "./main.js";

const withOpenAICodexProviderScope = vi.hoisted(() =>
  vi.fn(<T>(run: () => Promise<T>) => run()),
);

vi.mock("../services/OpenAICodexProvider.js", () => ({
  withOpenAICodexProviderScope,
}));

async function withConfigFile(
  contents: string,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "poink-main-test-"));
  const configPath = join(directory, "config.json");
  const previousConfigPath = process.env.POINK_CONFIG;
  writeFileSync(configPath, contents);
  process.env.POINK_CONFIG = configPath;

  try {
    await run(directory);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.POINK_CONFIG;
    } else {
      process.env.POINK_CONFIG = previousConfigPath;
    }
    await removeDirWithRetries(directory);
  }
}

describe("CLI command family routing", () => {
  test.each([
    ["help", "lightweight"],
    ["config", "lightweight"],
    ["stats", "store"],
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
