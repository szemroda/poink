import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  Config,
  LibraryConfig,
  loadConfig,
  normalizeConfig,
  resolveVisualsConfig,
} from "./types.js";

const ORIGINAL_POINK_CONFIG = process.env.POINK_CONFIG;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL;
const ORIGINAL_GOOGLE_GENERATIVE_AI_API_KEY =
  process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "poink-config-"));
}

afterEach(() => {
  if (ORIGINAL_POINK_CONFIG === undefined) {
    delete process.env.POINK_CONFIG;
  } else {
    process.env.POINK_CONFIG = ORIGINAL_POINK_CONFIG;
  }

  if (ORIGINAL_OPENROUTER_API_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
  }

  if (ORIGINAL_OPENROUTER_BASE_URL === undefined) {
    delete process.env.OPENROUTER_BASE_URL;
  } else {
    process.env.OPENROUTER_BASE_URL = ORIGINAL_OPENROUTER_BASE_URL;
  }

  if (ORIGINAL_GOOGLE_GENERATIVE_AI_API_KEY === undefined) {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  } else {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = ORIGINAL_GOOGLE_GENERATIVE_AI_API_KEY;
  }

  if (ORIGINAL_ANTHROPIC_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
  }
});

describe("loadConfig path and database defaults", () => {
  test("uses POINK_CONFIG path without persisting missing defaults", () => {
    const tempDir = makeTempDir();

    try {
      const configPath = join(tempDir, "custom-config.json");
      process.env.POINK_CONFIG = configPath;

      const config = loadConfig();

      expect(existsSync(configPath)).toBe(false);
      expect(config.version).toBe(1);
      expect(config.storage.backend).toBe("libsql");
      expect(config.storage.qdrant.url).toBe("http://localhost:6333");
      expect(config.storage.qdrant.collection).toBe("poink");
      expect(config.chunking.size).toBe(2000);
      expect(config.chunking.overlap).toBe(200);
      expect(config.cli.globalFlags.format).toBe("text");
      expect(config.ingest.urlDownloads.maxFileSize).toBe("100mb");
      expect(config.ingest.urlDownloads.timeout).toBe("30s");
      expect(config.ingest.urlDownloads.maxRedirects).toBe(5);
      expect(config.ingest.urlDownloads.allowPrivateNetwork).toBe(false);
      expect(config.ingest.urlDownloads.allowedPrivateNetworkHosts).toEqual([]);
      expect(config.ingest.visuals.enabled).toBe(false);
      expect(config.ingest.visuals.maxImageBytes).toBe("5mb");
      expect(config.ingest.visuals.maxImagesPerDocument).toBe(100);
      expect(config.server.host).toBe("127.0.0.1");
      expect(config.server.port).toBe(3838);
      expect(config.server.auth.enabled).toBe(false);
      expect(config.server.auth.token).toBeUndefined();
      expect(config.models.enrichment.model).toBe("llama3.2:3b");
      expect(config.models.enrichment.reasoning).toBeUndefined();
      expect(config.models.judge.model).toBe("llama3.2:3b");
      expect(config.models.judge.reasoning).toBeUndefined();
      expect(config.providers.openrouter.apiKey).toBeUndefined();
      expect(config.providers.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(config.providers.google.apiKey).toBeUndefined();
      expect(config.providers.google.apiKeyEnv).toBe(
        "GOOGLE_GENERATIVE_AI_API_KEY",
      );
      expect(config.providers.google.baseUrl).toBe(
        "https://generativelanguage.googleapis.com/v1beta",
      );
      expect(config.providers.anthropic.apiKey).toBeUndefined();
      expect(config.providers.anthropic.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
      expect(config.providers.anthropic.baseUrl).toBe(
        "https://api.anthropic.com/v1",
      );
      expect(config.providers["openai-codex"]).toEqual({});
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves OpenRouter config from environment variables", () => {
    const tempDir = makeTempDir();

    try {
      const configPath = join(tempDir, "config.json");
      process.env.POINK_CONFIG = configPath;
      process.env.OPENROUTER_API_KEY = "env-openrouter-key";
      process.env.OPENROUTER_BASE_URL = "https://openrouter.example/api/v1";

      const config = loadConfig();

      expect(config.openrouterApiKey).toBe("env-openrouter-key");
      expect(config.openrouterBaseUrl).toBe("https://openrouter.example/api/v1");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("explicit OpenRouter base URL config takes precedence over environment", () => {
    const tempDir = makeTempDir();

    try {
      const configPath = join(tempDir, "config.json");
      const config = JSON.parse(JSON.stringify(Config.Default));
      config.providers.openrouter.baseUrl = "https://configured.example/api/v1";

      process.env.POINK_CONFIG = configPath;
      process.env.OPENROUTER_BASE_URL = "https://env.example/api/v1";
      writeFileSync(configPath, JSON.stringify(config), "utf-8");

      expect(loadConfig().openrouterBaseUrl).toBe(
        "https://configured.example/api/v1",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves Google and Anthropic config from environment variables", () => {
    const tempDir = makeTempDir();

    try {
      const configPath = join(tempDir, "config.json");
      process.env.POINK_CONFIG = configPath;
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "env-google-key";
      process.env.ANTHROPIC_API_KEY = "env-anthropic-key";

      const config = loadConfig();

      expect(config.googleApiKey).toBe("env-google-key");
      expect(config.anthropicApiKey).toBe("env-anthropic-key");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects Anthropic as an embedding provider", () => {
    const tempDir = makeTempDir();

    try {
      const configPath = join(tempDir, "config.json");
      const config = JSON.parse(JSON.stringify(Config.Default));
      config.models.embedding.provider = "anthropic";
      config.models.embedding.model = "claude-3-5-haiku-20241022";
      config.models.enrichment.provider = "anthropic";
      config.models.enrichment.model = "claude-3-5-haiku-20241022";

      process.env.POINK_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify(config), "utf-8");

      expect(() => loadConfig()).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("accepts OpenAI Codex for language roles and rejects it for embeddings", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    config.models.enrichment.provider = "openai-codex";
    config.models.enrichment.model = "gpt-5.5";
    config.models.judge.provider = "openai-codex";
    config.models.judge.model = "gpt-5.5";
    const normalized = normalizeConfig(config);

    expect(normalized.models.enrichment.provider).toBe("openai-codex");
    expect(normalized.models.judge.provider).toBe("openai-codex");
    expect(normalized.providers["openai-codex"]).toEqual({});

    config.models.embedding.provider = "openai-codex";
    config.models.embedding.model = "gpt-5.5";

    expect(() => normalizeConfig(config)).toThrow();
  });

  test("rejects OpenAI Codex provider configuration in bundled-only mode", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    config.providers["openai-codex"] = { codexPath: "C:\\tools\\codex.cmd" };

    expect(() => normalizeConfig(config)).toThrow(
      /does not accept configuration/,
    );
  });

  test("accepts optional reasoning levels for language model roles", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    config.models.enrichment.reasoning = "high";
    config.models.judge.reasoning = "none";

    const normalized = normalizeConfig(config);

    expect(normalized.models.enrichment.reasoning).toBe("high");
    expect(normalized.models.judge.reasoning).toBe("none");
  });

  test("normalizes legacy configs without CLI settings to text output", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    delete config.cli;

    const normalized = normalizeConfig(config);

    expect(normalized.cli.globalFlags.format).toBe("text");
  });

  test("rejects invalid CLI default format values", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    config.cli.globalFlags.format = "xml";

    expect(() => normalizeConfig(config)).toThrow();
  });

  test("normalizes legacy configs without ingest URL download settings", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    delete config.ingest;

    const normalized = normalizeConfig(config);

    expect(normalized.ingest.urlDownloads.maxFileSize).toBe("100mb");
    expect(normalized.ingest.urlDownloads.timeout).toBe("30s");
    expect(normalized.ingest.urlDownloads.maxRedirects).toBe(5);
    expect(normalized.ingest.visuals.enabled).toBe(false);
    expect(normalized.ingest.visuals.maxImageBytes).toBe("5mb");
    expect(normalized.ingest.visuals.maxImagesPerDocument).toBe(100);
  });

  test("normalizes legacy configs without visual settings", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    delete config.ingest.visuals;

    const normalized = normalizeConfig(config);

    expect(normalized.ingest.visuals.enabled).toBe(false);
    expect(normalized.ingest.visuals.maxImageBytes).toBe("5mb");
    expect(normalized.ingest.visuals.maxImagesPerDocument).toBe(100);
  });

  test("rejects numeric URL download max file sizes", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    config.ingest.urlDownloads.maxFileSize = 104857600;

    expect(() => normalizeConfig(config)).toThrow();
  });

  test("rejects URL download sizes and timeouts without units", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    config.ingest.urlDownloads.maxFileSize = "100";
    expect(() => normalizeConfig(config)).toThrow();

    config.ingest.urlDownloads.maxFileSize = "100mb";
    config.ingest.urlDownloads.timeout = "30";
    expect(() => normalizeConfig(config)).toThrow();
  });

  test("validates visual enrichment settings", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    config.ingest.visuals.enabled = true;
    config.ingest.visuals.maxImageBytes = "10mb";
    config.ingest.visuals.maxImagesPerDocument = 25;

    const normalized = normalizeConfig(config);
    const resolved = resolveVisualsConfig(normalized);

    expect(resolved.enabled).toBe(true);
    expect(resolved.maxImageBytes).toBe(10 * 1024 * 1024);
    expect(resolved.maxImagesPerDocument).toBe(25);

    config.ingest.visuals.maxImageBytes = "10";
    expect(() => normalizeConfig(config)).toThrow();

    config.ingest.visuals.maxImageBytes = "10mb";
    config.ingest.visuals.maxImagesPerDocument = -1;
    expect(() => normalizeConfig(config)).toThrow();
  });

  test("accepts null reasoning as provider default", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    config.models.enrichment.reasoning = null;
    config.models.judge.reasoning = null;

    const normalized = normalizeConfig(config);

    expect(normalized.models.enrichment.reasoning).toBeNull();
    expect(normalized.models.judge.reasoning).toBeNull();
  });

  test("rejects invalid reasoning levels", () => {
    const config = JSON.parse(JSON.stringify(Config.Default));
    config.models.enrichment.reasoning = "max";

    expect(() => normalizeConfig(config)).toThrow();
  });

  test("rejects invalid chunking instead of falling back to defaults", () => {
    const tempDir = makeTempDir();

    try {
      const configPath = join(tempDir, "config.json");
      const config = JSON.parse(JSON.stringify(Config.Default));
      config.library.path = join(tempDir, "library");
      config.chunking.size = 100;
      config.chunking.overlap = 100;

      process.env.POINK_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify(config), "utf-8");

      expect(() => loadConfig()).toThrow(
        "chunkOverlap (100) must be smaller than chunkSize (100)",
      );
      expect(() => LibraryConfig.fromEnv()).toThrow(
        "chunkOverlap (100) must be smaller than chunkSize (100)",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
