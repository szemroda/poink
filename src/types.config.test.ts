import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Config, LibraryConfig, loadConfig } from "./types.js";

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
  test("uses POINK_CONFIG path and creates defaults including database backend", () => {
    const tempDir = makeTempDir();

    try {
      const configPath = join(tempDir, "custom-config.json");
      process.env.POINK_CONFIG = configPath;

      const config = loadConfig();

      expect(existsSync(configPath)).toBe(true);
      expect(config.version).toBe(1);
      expect(config.storage.backend).toBe("libsql");
      expect(config.storage.qdrant.url).toBe("http://localhost:6333");
      expect(config.storage.qdrant.collection).toBe("poink");
      expect(config.chunking.size).toBe(2000);
      expect(config.chunking.overlap).toBe(200);
      expect(config.server.host).toBe("127.0.0.1");
      expect(config.server.port).toBe(3838);
      expect(config.server.auth.enabled).toBe(false);
      expect(config.server.auth.token).toBeUndefined();
      expect(config.models.enrichment.model).toBe("llama3.2:3b");
      expect(config.models.judge.model).toBe("llama3.2:3b");
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
