import { afterEach, describe, expect, test } from "vitest";
import { Config, normalizeConfig } from "../types.js";
import {
  buildOpenAICodexLoginCommand,
  closeOpenAICodexProviderManager,
  getOpenAICodexConfiguredRoles,
  getOpenAICodexProviderManager,
  resolveOpenAICodexCommand,
  withOpenAICodexProviderScope,
} from "./OpenAICodexProvider.js";

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

afterEach(async () => {
  await closeOpenAICodexProviderManager();
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

  test("uses the bundled Codex runtime for login", () => {
    const command = resolveOpenAICodexCommand();
    expect(command.command).toBe(process.execPath);
    expect(command.args).toHaveLength(1);
    expect(command.args[0]).toContain("@openai");
    expect(command.args[0]).toContain("codex");
    expect(command.args[0]).toContain("bin");
    expect(command.args[0]).toMatch(/codex\.js$/);

    expect(buildOpenAICodexLoginCommand()).toEqual({
      command: process.execPath,
      args: [...command.args, "login"],
    });

    expect(buildOpenAICodexLoginCommand({ deviceAuth: true })).toEqual({
      command: process.execPath,
      args: [...command.args, "login", "--device-auth"],
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
      firstManager = getOpenAICodexProviderManager();
      firstScopeReady();
      await new Promise<void>((resolve) => {
        releaseFirstScope = resolve;
      });
    });

    try {
      await firstScopeStarted;

      await withOpenAICodexProviderScope(async () => {
        expect(getOpenAICodexProviderManager()).toBe(firstManager);
      });

      expect(getOpenAICodexProviderManager()).toBe(firstManager);
    } finally {
      releaseFirstScope();
      await firstScope;
    }

    expect(getOpenAICodexProviderManager()).not.toBe(firstManager);
  });
});
