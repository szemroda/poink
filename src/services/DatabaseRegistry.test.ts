import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "./Database.js";
import { DatabaseRegistry } from "./DatabaseRegistry.js";
import { removeDirWithRetries } from "../testUtils.js";

function withTempEnv(
  env: Record<string, string>,
  run: () => Promise<void> | void
): Promise<void> | void {
  const previousValues = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previousValues.set(key, process.env[key]);
    process.env[key] = value;
  }

  const cleanup = () => {
    for (const [key, previous] of previousValues.entries()) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  };

  try {
    const result = run();
    if (result instanceof Promise) {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

describe("DatabaseRegistry", () => {
  const makeConfig = (
    tempDir: string,
    backend: "libsql" | "qdrant",
  ) => ({
    version: 1,
    library: { path: join(tempDir, "library") },
    chunking: { strategy: "text", size: 2000, overlap: 200 },
    models: {
      embedding: { provider: "ollama", model: "mxbai-embed-large" },
      enrichment: { provider: "ollama", model: "llama3.2:3b" },
      judge: { provider: "ollama", model: "llama3.2:3b" },
    },
    providers: {
      ollama: { baseUrl: "http://localhost:11434", autoPull: true },
      gateway: { apiKeyEnv: "AI_GATEWAY_API_KEY" },
      openai: {
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
      },
      openrouter: {
        apiKeyEnv: "OPENROUTER_API_KEY",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    },
    storage: {
      backend,
      libsql: { url: `file:${join(tempDir, "library", "library.db")}` },
      qdrant: {
        url: "http://localhost:6333",
        collection: "poink",
        apiKeyEnv: "QDRANT_API_KEY",
      },
    },
    server: {
      host: "127.0.0.1",
      port: 3838,
      auth: { enabled: false, tokenEnv: "POINK_SERVER_TOKEN" },
    },
  });

  test("returns a working libsql database layer when backend is libsql", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "poink-db-registry-"));
    const configPath = join(tempDir, "config.json");
    const libraryPath = join(tempDir, "library");

    try {
      mkdirSync(libraryPath, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(makeConfig(tempDir, "libsql")),
        "utf-8"
      );

      await withTempEnv(
        {
          POINK_CONFIG: configPath,
        },
        async () => {
          const program = Effect.gen(function* () {
            const db = yield* Database;
            return yield* db.getStats();
          });

          const stats = await Effect.runPromise(
            Effect.scoped(program.pipe(Effect.provide(DatabaseRegistry.make())))
          );

          expect(stats.documents).toBe(0);
          expect(stats.chunks).toBe(0);
          expect(stats.embeddings).toBe(0);
        }
      );
    } finally {
      await removeDirWithRetries(tempDir);
    }
  });

  test("returns a qdrant database layer when backend is qdrant", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "poink-db-registry-"));
    const configPath = join(tempDir, "config.json");
    const libraryPath = join(tempDir, "library");

    try {
      mkdirSync(libraryPath, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(makeConfig(tempDir, "qdrant")),
        "utf-8"
      );

      await withTempEnv(
        {
          POINK_CONFIG: configPath,
        },
        async () => {
          const program = Effect.gen(function* () {
            const db = yield* Database;
            return {
              hasAddDocument: typeof db.addDocument === "function",
              hasVectorSearch: typeof db.vectorSearch === "function",
            };
          });

          const result = await Effect.runPromise(
            Effect.scoped(program.pipe(Effect.provide(DatabaseRegistry.make())))
          );

          expect(result.hasAddDocument).toBe(true);
          expect(result.hasVectorSearch).toBe(true);
        }
      );
    } finally {
      await removeDirWithRetries(tempDir);
    }
  });

  test("uses provided config object", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "poink-db-registry-"));

    try {
      const config = makeConfig(tempDir, "libsql");

      const program = Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.getStats();
      });

      const stats = await Effect.runPromise(
        Effect.scoped(
          program.pipe(
            Effect.provide(
              DatabaseRegistry.make({
                config: {
                  ...config,
                  storage: {
                    ...config.storage,
                    libsql: { url: ":memory:" },
                  },
                } as any,
              })
            )
          )
        )
      );

      expect(stats.documents).toBe(0);
      expect(stats.chunks).toBe(0);
      expect(stats.embeddings).toBe(0);
    } finally {
      await removeDirWithRetries(tempDir);
    }
  });
});
