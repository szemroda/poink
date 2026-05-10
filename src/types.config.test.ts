import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "./types.js";

const ORIGINAL_POINK_CONFIG = process.env.POINK_CONFIG;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL;

const LEGACY_CONFIG_SHAPE = {
  embedding: {
    provider: "ollama",
    model: "mxbai-embed-large",
  },
  enrichment: {
    provider: "ollama",
    model: "llama3.2",
  },
  judge: {
    provider: "ollama",
    model: "llama3.2",
  },
  ollama: {
    host: "http://localhost:11434",
    autoInstall: true,
  },
  gateway: {},
};

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
});

describe("loadConfig path and database defaults", () => {
  test("uses POINK_CONFIG path and creates defaults including database backend", () => {
    const tempDir = makeTempDir();

    try {
      const configPath = join(tempDir, "custom-config.json");
      process.env.POINK_CONFIG = configPath;

      const config = loadConfig();

      expect(existsSync(configPath)).toBe(true);
      expect(config.database.backend).toBe("libsql");
      expect(config.database.qdrant.url).toBe("http://localhost:6333");
      expect(config.database.qdrant.collection).toBe("poink");
      expect(config.server.host).toBe("127.0.0.1");
      expect(config.server.port).toBe(3838);
      expect(config.server.auth.enabled).toBe(false);
      expect(config.server.auth.token).toBeUndefined();
      expect(config.enrichment.model).toBe("llama3.2:3b");
      expect(config.judge.model).toBe("llama3.2:3b");
      expect(config.openrouter.apiKey).toBeUndefined();
      expect(config.openrouter.baseUrl).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("applies default database settings when loading legacy config without database section", () => {
    const tempDir = makeTempDir();

    try {
      const configPath = join(tempDir, "legacy-config.json");
      process.env.POINK_CONFIG = configPath;
      writeFileSync(configPath, JSON.stringify(LEGACY_CONFIG_SHAPE), "utf-8");

      const config = loadConfig();
      expect(config.database.backend).toBe("libsql");
      expect(config.database.qdrant.url).toBe("http://localhost:6333");
      expect(config.database.qdrant.collection).toBe("poink");
      expect(config.server.host).toBe("127.0.0.1");
      expect(config.server.port).toBe(3838);
      expect(config.server.auth.enabled).toBe(false);
      expect(config.server.auth.token).toBeUndefined();
      expect(config.enrichment.model).toBe("llama3.2");
      expect(config.judge.model).toBe("llama3.2");
      expect(config.openrouter.apiKey).toBeUndefined();
      expect(config.openrouter.baseUrl).toBeUndefined();
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
});
