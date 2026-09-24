import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  Config,
  expandHomePath,
  LibraryConfig,
  loadConfig,
  normalizeConfig,
  resolveConfigPath,
  resolveLibsqlAuthToken,
  resolveVisualsConfig,
  withConfigPathOverride,
} from "./types.js";
import { restoreEnvSnapshot, snapshotEnv, withEnv } from "./testUtils.js";

const CONFIG_ENV_NAMES = [
  "POINK_CONFIG",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;
const ORIGINAL_ENV = snapshotEnv(CONFIG_ENV_NAMES);

afterEach(() => {
  restoreEnvSnapshot(ORIGINAL_ENV);
});

function withTempDir<T>(run: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "poink-config-"));
  try {
    return run(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the default config as plain JSON with dotted-path overrides applied.
 * An `undefined` override deletes the key.
 */
function configWith(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const config: Record<string, unknown> = JSON.parse(
    JSON.stringify(Config.Default),
  );
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split(".");
    const leaf = keys.pop()!;
    let target = config;
    for (const key of keys) {
      const next = target[key];
      if (!isRecord(next)) throw new Error(`No config object at ${path}`);
      target = next;
    }
    if (value === undefined) {
      delete target[leaf];
    } else {
      target[leaf] = value;
    }
  }
  return config;
}

describe("loadConfig path and database defaults", () => {
  test("uses POINK_CONFIG path without persisting missing defaults", () => {
    withTempDir((tempDir) => {
      const configPath = join(tempDir, "custom-config.json");
      process.env.POINK_CONFIG = configPath;

      const config = loadConfig();

      expect(existsSync(configPath)).toBe(false);
      expect(config).toMatchObject({
        version: 1,
        storage: { libsql: { url: "file:~/.poink/library.db" } },
        chunking: { size: 2000, overlap: 200 },
        cli: { globalFlags: { format: "text" } },
        ingest: {
          include: [],
          exclude: [],
          urlDownloads: {
            maxFileSize: "100mb",
            timeout: "30s",
            maxRedirects: 5,
            allowPrivateNetwork: false,
            allowedPrivateNetworkHosts: [],
          },
          visuals: {
            enabled: false,
            maxImageBytes: "5mb",
            maxImagesPerDocument: 100,
          },
        },
        server: { host: "127.0.0.1", port: 3838, auth: { enabled: false } },
        models: {
          enrichment: { model: "llama3.2:3b" },
          judge: { model: "llama3.2:3b" },
        },
        providers: {
          openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
          google: {
            apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          },
          anthropic: {
            apiKeyEnv: "ANTHROPIC_API_KEY",
            baseUrl: "https://api.anthropic.com/v1",
          },
          "openai-codex": {},
        },
      });
      expect(config.server.auth.token).toBeUndefined();
      expect(config.models.enrichment.reasoning).toBeUndefined();
      expect(config.models.judge.reasoning).toBeUndefined();
      expect(config.providers.openrouter.apiKey).toBeUndefined();
      expect(config.providers.google.apiKey).toBeUndefined();
      expect(config.providers.anthropic.apiKey).toBeUndefined();
    });
  });

  test("scopes invocation config overrides across concurrent async calls", async () => {
    const envConfigPath = join(tmpdir(), "env-config.json");
    const firstConfigPath = join(tmpdir(), "first-config.json");
    const secondConfigPath = join(tmpdir(), "second-config.json");
    process.env.POINK_CONFIG = envConfigPath;

    let releaseFirst: () => void = () => undefined;
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withConfigPathOverride(firstConfigPath, async () => {
      expect(resolveConfigPath()).toBe(firstConfigPath);
      await firstWait;
      expect(resolveConfigPath()).toBe(firstConfigPath);
      return resolveConfigPath();
    });

    const second = withConfigPathOverride(secondConfigPath, async () => {
      expect(resolveConfigPath()).toBe(secondConfigPath);
      await Promise.resolve();
      expect(resolveConfigPath()).toBe(secondConfigPath);
      releaseFirst();
      return resolveConfigPath();
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      firstConfigPath,
      secondConfigPath,
    ]);
    expect(resolveConfigPath()).toBe(envConfigPath);
  });

  test("accepts legacy libsql backend fields and strips stale qdrant config", () => {
    const config = normalizeConfig(
      configWith({
        storage: {
          backend: "libsql",
          libsql: { url: ":memory:" },
          qdrant: {
            url: "http://localhost:6333",
            collection: "poink",
          },
        },
      }),
    );

    expect(config.storage).toEqual({ libsql: { url: ":memory:" } });
  });

  test("rejects an explicitly selected qdrant backend with re-ingest guidance", () => {
    expect(() =>
      normalizeConfig(
        configWith({
          storage: { backend: "qdrant", libsql: { url: ":memory:" } },
        }),
      ),
    ).toThrow(/Qdrant storage is no longer supported.*re-ingest/i);
  });

  test("requires a configured libsql auth token environment variable", () => {
    const variable = "POINK_TEST_MISSING_AUTH_TOKEN";
    const config = new Config({
      ...Config.Default,
      storage: {
        libsql: {
          url: "libsql://example.invalid",
          authTokenEnv: variable,
        },
      },
    });

    withEnv({ [variable]: undefined }, () => {
      expect(() => resolveLibsqlAuthToken(config)).toThrow(variable);
    });
  });

  test("resolves provider API keys and OpenRouter base URL from environment variables", () => {
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    process.env.OPENROUTER_BASE_URL = "https://openrouter.example/api/v1";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "env-google-key";
    process.env.ANTHROPIC_API_KEY = "env-anthropic-key";

    expect(Config.Default).toMatchObject({
      openrouterApiKey: "env-openrouter-key",
      openrouterBaseUrl: "https://openrouter.example/api/v1",
      googleApiKey: "env-google-key",
      anthropicApiKey: "env-anthropic-key",
    });
  });

  test("explicit OpenRouter base URL config takes precedence over environment", () => {
    process.env.OPENROUTER_BASE_URL = "https://env.example/api/v1";
    const config = normalizeConfig(
      configWith({
        "providers.openrouter.baseUrl": "https://configured.example/api/v1",
      }),
    );

    expect(config.openrouterBaseUrl).toBe("https://configured.example/api/v1");
  });

  test.each([
    ["Anthropic as embedding provider", { "models.embedding.provider": "anthropic" }],
    ["OpenAI Codex as embedding provider", { "models.embedding.provider": "openai-codex" }],
    ["an invalid CLI default format", { "cli.globalFlags.format": "xml" }],
    ["an invalid reasoning level", { "models.enrichment.reasoning": "max" }],
    ["non-string ingest include patterns", { "ingest.include": ["docs/**/*.md", 3] }],
    ["non-string ingest exclude patterns", { "ingest.exclude": [false] }],
    ["a numeric URL download max file size", { "ingest.urlDownloads.maxFileSize": 104857600 }],
    ["a unitless URL download max file size", { "ingest.urlDownloads.maxFileSize": "100" }],
    ["a unitless URL download timeout", { "ingest.urlDownloads.timeout": "30" }],
    ["a unitless visual max image size", { "ingest.visuals.maxImageBytes": "10" }],
    ["a negative visual image limit", { "ingest.visuals.maxImagesPerDocument": -1 }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => normalizeConfig(configWith(overrides))).toThrow();
  });

  test.each(["cli", "ingest", "ingest.visuals"])(
    "fills a legacy config missing %s with the defaults",
    (path) => {
      const normalized = normalizeConfig(configWith({ [path]: undefined }));

      expect({ cli: normalized.cli, ingest: normalized.ingest }).toEqual({
        cli: Config.Default.cli,
        ingest: Config.Default.ingest,
      });
    },
  );

  test("accepts OpenAI Codex for language roles with an uninstalled Codex path", () => {
    const normalized = normalizeConfig(
      configWith({
        "models.enrichment.provider": "openai-codex",
        "models.judge.provider": "openai-codex",
        "providers.openai-codex": { codexPath: "C:\\tools\\codex.cmd" },
      }),
    );

    expect(normalized.models.enrichment.provider).toBe("openai-codex");
    expect(normalized.models.judge.provider).toBe("openai-codex");
    expect(normalized.providers["openai-codex"]).toEqual({
      codexPath: "C:\\tools\\codex.cmd",
    });
  });

  test.each([
    "provider-default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    null,
  ])("accepts %s reasoning for language model roles", (reasoning) => {
    const normalized = normalizeConfig(
      configWith({
        "models.enrichment.reasoning": reasoning,
        "models.judge.reasoning": reasoning,
      }),
    );

    expect(normalized.models.enrichment.reasoning).toBe(reasoning);
    expect(normalized.models.judge.reasoning).toBe(reasoning);
  });

  test("accepts configured ingest include and exclude patterns", () => {
    const normalized = normalizeConfig(
      configWith({
        "ingest.include": ["docs/**/*.md"],
        "ingest.exclude": ["docs/archive/**"],
      }),
    );

    expect(normalized.ingest.include).toEqual(["docs/**/*.md"]);
    expect(normalized.ingest.exclude).toEqual(["docs/archive/**"]);
  });

  test("resolves visual enrichment settings", () => {
    const normalized = normalizeConfig(
      configWith({
        "ingest.visuals": {
          enabled: true,
          maxImageBytes: "10mb",
          maxImagesPerDocument: 25,
        },
      }),
    );

    expect(resolveVisualsConfig(normalized)).toEqual({
      enabled: true,
      maxImageBytes: 10 * 1024 * 1024,
      maxImagesPerDocument: 25,
    });
  });

  test("rejects invalid chunking instead of falling back to defaults", () => {
    withTempDir((tempDir) => {
      const configPath = join(tempDir, "config.json");
      process.env.POINK_CONFIG = configPath;
      writeFileSync(
        configPath,
        JSON.stringify(
          configWith({
            "library.path": join(tempDir, "library"),
            "chunking.size": 100,
            "chunking.overlap": 100,
          }),
        ),
        "utf-8",
      );

      const message = "chunkOverlap (100) must be smaller than chunkSize (100)";
      expect(() => loadConfig()).toThrow(message);
      expect(() => LibraryConfig.fromEnv()).toThrow(message);
    });
  });
});

describe("LibraryConfig path resolution", () => {
  test("defaults to .poink when config omits a library path", () => {
    withTempDir((tempDir) => {
      withEnv(
        {
          POINK_CONFIG: join(tempDir, "config.json"),
          HOME: undefined,
          USERPROFILE: "C:\\Users\\tester",
        },
        () => {
          expect(LibraryConfig.fromEnv()).toMatchObject({
            libraryPath: "C:\\Users\\tester\\.poink",
            dbPath: "C:\\Users\\tester\\.poink\\library.db",
          });
        },
      );
    });
  });

  test("expands ~ using the resolved home directory", () => {
    withEnv({ HOME: undefined, USERPROFILE: "C:\\Users\\tester" }, () => {
      expect(expandHomePath("~")).toBe("C:\\Users\\tester");
      expect(expandHomePath("~/docs/file.pdf")).toBe(
        "C:\\Users\\tester\\docs\\file.pdf",
      );
    });
  });
});
