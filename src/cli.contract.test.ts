import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function makeTestConfig(
  libraryPath: string,
  modelProvider: "ollama" | "openrouter" = "ollama",
) {
  const models =
    modelProvider === "openrouter"
      ? {
          embedding: {
            provider: "openrouter",
            model: "openai/text-embedding-3-small",
          },
          enrichment: {
            provider: "openrouter",
            model: "anthropic/claude-3.5-haiku",
          },
          judge: {
            provider: "openrouter",
            model: "anthropic/claude-3.5-haiku",
          },
        }
      : {
          embedding: {
            provider: "ollama",
            model: "mxbai-embed-large",
          },
          enrichment: {
            provider: "ollama",
            model: "llama3.2:3b",
          },
          judge: {
            provider: "ollama",
            model: "llama3.2:3b",
          },
        };

  return {
    version: 1,
    library: { path: libraryPath },
    chunking: { strategy: "text", size: 2000, overlap: 200 },
    models,
    providers: {
      ollama: {
        baseUrl: "http://127.0.0.1:1",
        autoPull: true,
      },
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
      backend: "libsql",
      libsql: { url: `file:${join(libraryPath, "library.db")}` },
      qdrant: {
        url: "http://localhost:6333",
        collection: "poink",
        apiKeyEnv: "QDRANT_API_KEY",
      },
    },
    server: {
      host: "127.0.0.1",
      port: 3838,
      auth: {
        enabled: false,
        tokenEnv: "POINK_SERVER_TOKEN",
      },
    },
  };
}

function writeTestConfig(
  configPath: string,
  libraryPath: string,
  modelProvider?: "ollama" | "openrouter",
): void {
  writeFileSync(
    configPath,
    JSON.stringify(makeTestConfig(libraryPath, modelProvider), null, 2),
    "utf-8",
  );
}

function envForConfig(configPath: string): Record<string, string> {
  return {
    POINK_CONFIG: configPath,
    POINK_LOG_LEVEL: "silent",
  };
}

function runCli(
  argv: string[],
  opts?: { env?: Record<string, string | undefined> },
): { exitCode: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    ...process.env,
    ...(opts?.env ?? {}),
  } as any;

  const proc = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...argv], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: proc.exitCode ?? 0,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function withTempLibraryPath<T>(fn: (libraryPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "poink-cli-contract-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempLibraryPathAsync<T>(
  fn: (libraryPath: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "poink-cli-contract-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to determine ephemeral port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

describe("Node Build Smoke", () => {
  test(
    "dist CLI runs with node",
    () =>
      withTempLibraryPath((libraryPath) => {
        const configPath = join(libraryPath, "config.json");
        writeTestConfig(configPath, libraryPath);

        const build = Bun.spawnSync([process.execPath, "run", "build"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        if ((build.exitCode ?? 0) !== 0) {
          throw new Error(
            new TextDecoder().decode(build.stderr || build.stdout),
          );
        }

        const proc = Bun.spawnSync(["node", "dist/cli.js", "--help"], {
          env: {
            ...process.env,
            ...envForConfig(configPath),
          } as any,
          stdout: "pipe",
          stderr: "pipe",
        });

        expect(proc.exitCode ?? 0).toBe(0);
        const stdout = new TextDecoder().decode(proc.stdout);
        const envelope = JSON.parse(stdout);
        expect(envelope.ok).toBe(true);
        expect(envelope.command).toBe("help");
      }),
    { timeout: 30000 },
  );
});

describe("CLI JSON Envelope Contract", () => {
  test("stats emits a single JSON envelope with nextActions when not --quiet", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["stats", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim().startsWith("{")).toBe(true);

      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("stats");
      expect(obj.protocolVersion).toBe(1);
      expect(obj.result).toBeDefined();
      expect(obj.result.libraryPath).toBe(libraryPath);
      expect(obj.result.documents).toBe(0);
      expect(obj.result.chunks).toBe(0);
      expect(obj.result.embeddings).toBe(0);

      // Agent mode: nextActions should exist by default (unless --quiet)
      expect(Array.isArray(obj.nextActions)).toBe(true);
      expect(obj.nextActions.length).toBeGreaterThan(0);
    }));

  test("stats with --quiet omits nextActions", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["stats", "--format", "json", "--quiet"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("stats");
      expect("nextActions" in obj).toBe(false);
    }));

  test("invalid --format returns a structured error envelope and non-zero exit code", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["--format", "wat", "stats"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.protocolVersion).toBe(1);
      expect(obj.error).toBeDefined();
      expect(obj.error.code).toBe("INVALID_FLAG");
    }));

  test("rechunk flag validation: --max-docs requires a numeric value", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["rechunk", "--max-docs", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.error.code).toBe("INVALID_ARGS");
      expect(String(obj.error.message)).toContain("--max-docs");
    }));

  test("capabilities is self-describing and includes JSON Schemas", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["capabilities", "--format", "json", "--quiet"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("capabilities");
      expect(obj.protocolVersion).toBe(1);

      const result = obj.result;
      expect(result).toBeDefined();
      expect(result.protocolVersion).toBe(1);
      expect(typeof result.poinkVersion).toBe("string");

      // Command list invariants (agent discovery depends on these names)
      const commandNames = new Set(
        (result.commands as Array<any>).map((c) => String(c.name)),
      );
      expect(commandNames.has("search")).toBe(true);
      expect(commandNames.has("search-pack")).toBe(true);
      expect(commandNames.has("chunk")).toBe(true);
      expect(commandNames.has("doc")).toBe(true);
      expect(commandNames.has("page")).toBe(true);
      expect(commandNames.has("stats")).toBe(true);
      expect(commandNames.has("rechunk")).toBe(true);
      expect(commandNames.has("reindex")).toBe(true);
      expect(commandNames.has("mcp")).toBe(true);
      expect(commandNames.has("serve")).toBe(true);

      // Schema invariants (agents can validate/parses these)
      expect(result.schemas).toBeDefined();
      expect(result.schemas.Document).toBeDefined();
      expect(result.schemas.PDFChunk).toBeDefined();
      expect(result.schemas.SearchResult).toBeDefined();
      expect(result.schemas.Config).toBeDefined();

      // Lightweight stability assertions: required field names shouldn't drift.
      const docSchema = result.schemas.Document as any;
      expect(docSchema.type).toBe("object");
      expect(Array.isArray(docSchema.required)).toBe(true);
      expect(docSchema.required).toContain("id");
      expect(docSchema.required).toContain("title");
      expect(docSchema.required).toContain("path");
      expect(docSchema.required).toContain("tags");
    }));

  test("config show text output includes database backend details", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["config", "show", "--format", "text"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Storage:");
      expect(res.stdout).toContain("libsql");
      expect(res.stdout).toContain("Qdrant:");
    }));

  test("config show succeeds when configured library path does not exist yet", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "missing-library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["config", "show", "--format", "text"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("PDF Library Config");
      expect(res.stdout).toContain("Storage:");
    }));

  test("config set providers.openrouter.apiKey succeeds even when current config uses openrouter without a key", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");

      writeTestConfig(configPath, libraryPath, "openrouter");

      const res = runCli(
        ["config", "set", "providers.openrouter.apiKey", "test-openrouter-key"],
        {
          env: envForConfig(configPath),
        },
      );

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("config");
      expect(obj.result.path).toBe("providers.openrouter.apiKey");
      expect(obj.result.value).toBe("test-openrouter-key");

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.providers.openrouter.apiKey).toBe("test-openrouter-key");
    }));

  test("config set rejects invalid config keys and does not persist them", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        ["config", "set", "providers.openrouter.apiKeyyyyy", "123"],
        {
          env: envForConfig(configPath),
        },
      );

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.error.code).toBe("INVALID_ARGS");
      expect(String(obj.error.message)).toContain("providers.openrouter.apiKeyyyyy");

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.providers?.openrouter?.apiKeyyyyy).toBeUndefined();
    }));

  test("config set rejects invalid chunking combinations", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["config", "set", "chunking.overlap", "2000"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.error.code).toBe("INVALID_ARGS");
      expect(String(obj.error.message)).toContain("chunking.overlap");

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.chunking.overlap).toBe(200);
    }));

  test("init creates a missing library directory before opening the database", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "missing-library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath, "openrouter");

      const res = runCli(["init", "--format", "json", "--quiet"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);

      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("init");
      expect(obj.result.libraryPath).toBe(libraryPath);
      expect(obj.result.dbPath).toBe(join(libraryPath, "library.db"));
    }));
});

describe("MCP Tool Output Contract", () => {
  test(
    "mcp tools return structuredContent matching the agent envelope schema",
    async () =>
      withTempLibraryPathAsync(async (libraryPath) => {
        const configPath = join(libraryPath, "config.json");
        writeTestConfig(configPath, libraryPath);

        const transport = new StdioClientTransport({
          command: process.execPath,
          args: ["run", "src/cli.ts", "mcp", "--quiet"],
          cwd: process.cwd(),
          stderr: "pipe",
          env: {
            ...process.env,
            ...envForConfig(configPath),
          } as any,
        });

        const client = new Client({
          name: "poink-contract-test",
          version: "0.0.0",
        });

        try {
          await client.connect(transport);

          const tools = await client.listTools();
          const toolNames = new Set(tools.tools.map((t) => t.name));
          expect(toolNames.has("capabilities")).toBe(true);
          expect(toolNames.has("stats")).toBe(true);
          expect(toolNames.has("search")).toBe(true);

          const call = await client.callTool({ name: "stats", arguments: {} });
          expect(Boolean(call.isError)).toBe(false);
          expect(call.structuredContent).toBeDefined();

          const envelope: any = call.structuredContent;
          expect(envelope.ok).toBe(true);
          expect(envelope.command).toBe("stats");
          expect(envelope.protocolVersion).toBe(1);
          expect(envelope.result).toBeDefined();
          expect(envelope.result.libraryPath).toBe(libraryPath);
        } finally {
          try {
            await client.close();
          } catch {
            // ignore
          }
          try {
            await transport.close();
          } catch {
            // ignore
          }
        }
      }),
    { timeout: 20000 },
  );
});

describe("HTTP MCP Server", () => {
  test(
    "serve starts the HTTP MCP server and exposes /health",
    async () =>
      withTempLibraryPathAsync(async (libraryPath) => {
        const configPath = join(libraryPath, "config.json");
        writeTestConfig(configPath, libraryPath);

        const port = await getAvailablePort();
        const proc = Bun.spawn(
          [
            process.execPath,
            "run",
            "src/cli.ts",
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--quiet",
          ],
          {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              ...envForConfig(configPath),
            } as any,
          },
        );

        try {
          let health: Response | undefined;
          for (let i = 0; i < 40; i++) {
            try {
              health = await fetch(`http://127.0.0.1:${port}/health`);
              if (health.ok) break;
            } catch {
              // server not ready yet
            }
            await Bun.sleep(100);
          }

          expect(health).toBeDefined();
          expect(health?.ok).toBe(true);

          const body = await health!.json();
          expect(body).toEqual({
            ok: true,
            host: "127.0.0.1",
            port,
            auth: { enabled: false },
          });
        } finally {
          proc.kill();
          await proc.exited;
        }
      }),
    { timeout: 20000 },
  );
});
