import { describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function nodeTsxArgs(args: string[]): string[] {
  return ["--import", "tsx", "src/cli.ts", ...args];
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function makeTestConfig(
  libraryPath: string,
  modelProvider: "ollama" | "openrouter" = "ollama",
  cliFormat: "json" | "ndjson" | "text" = "text",
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
    cli: { globalFlags: { format: cliFormat } },
    ingest: {
      urlDownloads: {
        maxFileSize: "100mb",
        timeout: "30s",
        maxRedirects: 5,
        allowPrivateNetwork: false,
        allowedPrivateNetworkHosts: [],
      },
    },
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
  cliFormat?: "json" | "ndjson" | "text",
): void {
  writeFileSync(
    configPath,
    JSON.stringify(makeTestConfig(libraryPath, modelProvider, cliFormat), null, 2),
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

  const proc = spawnSync(process.execPath, nodeTsxArgs(argv), {
    env,
    encoding: "utf-8",
  });

  return {
    exitCode: proc.status ?? 0,
    stdout: proc.stdout,
    stderr: proc.stderr,
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

        const build = spawnSync(npmCommand(), ["run", "build"], {
          encoding: "utf-8",
        });
        if ((build.status ?? 0) !== 0) {
          throw new Error(build.stderr || build.stdout);
        }

        const proc = spawnSync(process.execPath, ["dist/cli.js", "--format", "json", "--help"], {
          env: {
            ...process.env,
            ...envForConfig(configPath),
          } as any,
          encoding: "utf-8",
        });

        expect(proc.status ?? 0).toBe(0);
        const envelope = JSON.parse(proc.stdout);
        expect(envelope.ok).toBe(true);
        expect(envelope.command).toBe("help");
      }),
    30000,
  );
});

describe("CLI JSON Envelope Contract", () => {
  test("stats emits text output by default", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["stats"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("PDF Library Stats");
      expect(res.stdout).toContain("Documents:  0");
    }));

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

  test("configured default format is used when --format is omitted", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath, "ollama", "json");

      const res = runCli(["stats"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("stats");
    }));

  test("--format overrides the configured default format", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath, "ollama", "json");

      const res = runCli(["stats", "--format", "text"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("PDF Library Stats");
      expect(() => JSON.parse(res.stdout)).toThrow();
    }));

  test("invalid --format returns a text error by default", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["--format", "wat", "stats"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("INVALID_FLAG");
      expect(res.stderr).toContain("Invalid --format value");
    }));

  test("invalid --format returns a structured error envelope when configured for JSON", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath, "ollama", "json");

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
      expect(result.defaultFormat).toBe("text");
      expect(result.factoryDefaultFormat).toBe("text");
      expect(result.configurableDefaultFormat).toBe("cli.globalFlags.format");

      // Command list invariants (agent discovery depends on these names)
      const commandNames = new Set(
        (result.commands as Array<any>).map((c) => String(c.name)),
      );
      expect(commandNames.has("search")).toBe(true);
      expect(commandNames.has("search-pack")).toBe(true);
      expect(commandNames.has("chunk")).toBe(true);
      expect(commandNames.has("doc")).toBe(true);
      expect(commandNames.has("page")).toBe(true);
      expect(commandNames.has("add")).toBe(true);
      expect(commandNames.has("stats")).toBe(true);
      expect(commandNames.has("rechunk")).toBe(true);
      expect(commandNames.has("reindex")).toBe(true);
      expect(commandNames.has("mcp")).toBe(true);
      expect(commandNames.has("serve")).toBe(true);
      expect(commandNames.has("providers")).toBe(true);
      const providersCommand = (result.commands as Array<any>).find(
        (c) => c.name === "providers",
      );
      expect(providersCommand?.argv).toEqual([
        "--format",
        "text",
        "providers",
        "login",
        "--provider",
        "openai-codex",
        "[--device-auth]",
      ]);

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

  test("capabilities reports configured default format separately from --format", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath, "ollama", "ndjson");

      const res = runCli(["capabilities", "--format", "json", "--quiet"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.result.defaultFormat).toBe("ndjson");
      expect(obj.result.factoryDefaultFormat).toBe("text");
      expect(obj.result.configurableDefaultFormat).toBe("cli.globalFlags.format");
    }));

  test("providers login requires text format because it is interactive", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["providers", "login", "--provider", "openai-codex", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.command).toBe("providers");
      expect(obj.error.code).toBe("INVALID_ARGS");
      expect(String(obj.error.message)).toContain("--format text");
      expect(obj.error.details.hint).toBe(
        "poink --format text providers login --provider openai-codex",
      );
    }));

  test("providers login rejects unsupported provider login flags", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        [
          "providers",
          "login",
          "--provider",
          "openai-codex",
          "--device-code",
          "--format",
          "json",
        ],
        {
          env: envForConfig(configPath),
        },
      );

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.command).toBe("providers");
      expect(obj.error.code).toBe("INVALID_ARGS");
      expect(String(obj.error.message)).toContain("--device-code");
      expect(obj.error.details.available).toContain("--device-auth");
    }));

  test("service-free command help does not require runtime services", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      for (const command of ["config", "providers"]) {
        const res = runCli([command, "--help", "--format", "json"], {
          env: envForConfig(configPath),
        });

        expect(res.exitCode).toBe(0);
        const obj = JSON.parse(res.stdout);
        expect(obj.ok).toBe(true);
        expect(obj.command).toBe("help");
        expect(obj.result.help).toContain(
          "poink --format text providers login --provider openai-codex",
        );
      }
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
      expect(res.stdout).toContain("OpenAI Codex:");
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

  test("config show redacts stored secrets in JSON output by default", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      const config: any = makeTestConfig(libraryPath);
      config.providers.openrouter.apiKey = "openrouter-secret";
      config.storage.libsql.authToken = "libsql-secret";
      config.storage.qdrant.apiKey = "qdrant-secret";
      config.server.auth.token = "server-secret";
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      const res = runCli(["config", "show", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain("openrouter-secret");
      expect(res.stdout).not.toContain("libsql-secret");
      expect(res.stdout).not.toContain("qdrant-secret");
      expect(res.stdout).not.toContain("server-secret");

      const obj = JSON.parse(res.stdout);
      expect(obj.result.config.providers.openrouter.apiKey).toBe("[redacted]");
      expect(obj.result.config.storage.libsql.authToken).toBe("[redacted]");
      expect(obj.result.config.storage.qdrant.apiKey).toBe("[redacted]");
      expect(obj.result.config.server.auth.token).toBe("[redacted]");
      expect(obj.result.config.providers.openrouter.apiKeyEnv).toBe("OPENROUTER_API_KEY");
      expect(obj.result.config.server.auth.tokenEnv).toBe("POINK_SERVER_TOKEN");
    }));

  test("config show returns stored secrets when explicitly requested", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      const config: any = makeTestConfig(libraryPath);
      config.providers.openrouter.apiKey = "openrouter-secret";
      config.server.auth.token = "server-secret";
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      const res = runCli(
        ["config", "show", "--show-secrets", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.result.config.providers.openrouter.apiKey).toBe("openrouter-secret");
      expect(obj.result.config.server.auth.token).toBe("server-secret");
    }));

  test("config get redacts stored secrets unless explicitly requested", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      const config: any = makeTestConfig(libraryPath);
      config.providers.openrouter.apiKey = "openrouter-secret";
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      const redacted = runCli(
        ["config", "get", "providers.openrouter.apiKey", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );
      expect(redacted.exitCode).toBe(0);
      expect(redacted.stdout).not.toContain("openrouter-secret");
      expect(JSON.parse(redacted.stdout).result.value).toBe("[redacted]");

      const raw = runCli(
        [
          "config",
          "get",
          "providers.openrouter.apiKey",
          "--show-secrets",
          "--format",
          "json",
        ],
        {
          env: envForConfig(configPath),
        },
      );
      expect(raw.exitCode).toBe(0);
      expect(JSON.parse(raw.stdout).result.value).toBe("openrouter-secret");
    }));

  test("config get redacts secrets inside parent object paths", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      const config: any = makeTestConfig(libraryPath);
      config.providers.openrouter.apiKey = "openrouter-secret";
      config.server.auth.token = "server-secret";
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      const provider = runCli(
        ["config", "get", "providers.openrouter", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );
      expect(provider.exitCode).toBe(0);
      expect(provider.stdout).not.toContain("openrouter-secret");
      expect(JSON.parse(provider.stdout).result.value.apiKey).toBe("[redacted]");

      const auth = runCli(["config", "get", "server.auth", "--format", "json"], {
        env: envForConfig(configPath),
      });
      expect(auth.exitCode).toBe(0);
      expect(auth.stdout).not.toContain("server-secret");
      expect(JSON.parse(auth.stdout).result.value.token).toBe("[redacted]");
    }));

  test("config set providers.openrouter.apiKey succeeds even when current config uses openrouter without a key", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");

      writeTestConfig(configPath, libraryPath, "openrouter");

      const res = runCli(
        [
          "config",
          "set",
          "providers.openrouter.apiKey",
          "test-openrouter-key",
          "--format",
          "json",
        ],
        {
          env: envForConfig(configPath),
        },
      );

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("config");
      expect(obj.result.path).toBe("providers.openrouter.apiKey");
      expect(obj.result.value).toBe("[redacted]");

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.providers.openrouter.apiKey).toBe("test-openrouter-key");
    }));

  test("config set redacts stored secrets in output but persists raw values", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath, "openrouter");

      const redacted = runCli(
        [
          "config",
          "set",
          "providers.openrouter.apiKey",
          "test-openrouter-key",
          "--format",
          "json",
        ],
        {
          env: envForConfig(configPath),
        },
      );

      expect(redacted.exitCode).toBe(0);
      expect(redacted.stdout).not.toContain("test-openrouter-key");
      expect(JSON.parse(redacted.stdout).result.value).toBe("[redacted]");
      let saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.providers.openrouter.apiKey).toBe("test-openrouter-key");

      const raw = runCli(
        [
          "config",
          "set",
          "providers.openrouter.apiKey",
          "replacement-openrouter-key",
          "--show-secrets",
          "--format",
          "json",
        ],
        {
          env: envForConfig(configPath),
        },
      );

      expect(raw.exitCode).toBe(0);
      expect(JSON.parse(raw.stdout).result.value).toBe("replacement-openrouter-key");
      saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.providers.openrouter.apiKey).toBe("replacement-openrouter-key");
    }));

  test("config set accepts language model reasoning levels and null", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const highRes = runCli(
        ["config", "set", "models.enrichment.reasoning", "high", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );

      expect(highRes.exitCode).toBe(0);
      const highObj = JSON.parse(highRes.stdout);
      expect(highObj.ok).toBe(true);
      expect(highObj.result.path).toBe("models.enrichment.reasoning");
      expect(highObj.result.value).toBe("high");

      const nullRes = runCli(
        ["config", "set", "models.judge.reasoning", "null", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );

      expect(nullRes.exitCode).toBe(0);
      const nullObj = JSON.parse(nullRes.stdout);
      expect(nullObj.ok).toBe(true);
      expect(nullObj.result.path).toBe("models.judge.reasoning");
      expect(nullObj.result.value).toBeNull();

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.models.enrichment.reasoning).toBe("high");
      expect(saved.models.judge.reasoning).toBeNull();
    }));

  test("config set accepts CLI default format values", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        ["config", "set", "cli.globalFlags.format", "json", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.result.path).toBe("cli.globalFlags.format");
      expect(obj.result.value).toBe("json");

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.cli.globalFlags.format).toBe("json");
    }));

  test("config set accepts URL download settings", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const sizeRes = runCli(
        ["config", "set", "ingest.urlDownloads.maxFileSize", "250mb", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );
      expect(sizeRes.exitCode).toBe(0);

      const hostsRes = runCli(
        [
          "config",
          "set",
          "ingest.urlDownloads.allowedPrivateNetworkHosts",
          "docs.internal,repo.internal",
          "--format",
          "json",
        ],
        {
          env: envForConfig(configPath),
        },
      );
      expect(hostsRes.exitCode).toBe(0);
      const hostsObj = JSON.parse(hostsRes.stdout);
      expect(hostsObj.ok).toBe(true);
      expect(hostsObj.result.value).toEqual(["docs.internal", "repo.internal"]);

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.ingest.urlDownloads.maxFileSize).toBe("250mb");
      expect(saved.ingest.urlDownloads.allowedPrivateNetworkHosts).toEqual([
        "docs.internal",
        "repo.internal",
      ]);
    }));

  test("config set accepts visual enrichment settings", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const enabledRes = runCli(
        ["config", "set", "ingest.visuals.enabled", "true", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );
      expect(enabledRes.exitCode).toBe(0);

      const sizeRes = runCli(
        [
          "config",
          "set",
          "ingest.visuals.maxImageBytes",
          "10mb",
          "--format",
          "json",
        ],
        {
          env: envForConfig(configPath),
        },
      );
      expect(sizeRes.exitCode).toBe(0);

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.ingest.visuals.enabled).toBe(true);
      expect(saved.ingest.visuals.maxImageBytes).toBe("10mb");
      expect(saved.ingest.visuals.maxImagesPerDocument).toBe(100);
    }));

  test("config set rejects unitless URL download max file size", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        ["config", "set", "ingest.urlDownloads.maxFileSize", "100", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.error.code).toBe("INVALID_ARGS");
    }));

  test("config set rejects invalid CLI default format values", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        ["config", "set", "cli.globalFlags.format", "xml", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.error.code).toBe("INVALID_ARGS");

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.cli.globalFlags.format).toBe("text");
    }));

  test("config set rejects invalid language model reasoning levels", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        ["config", "set", "models.enrichment.reasoning", "max", "--format", "json"],
        {
          env: envForConfig(configPath),
        },
      );

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.error.code).toBe("INVALID_ARGS");

      const saved = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(saved.models.enrichment.reasoning).toBeUndefined();
    }));

  test("config set rejects invalid config keys and does not persist them", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        ["config", "set", "providers.openrouter.apiKeyyyyy", "123", "--format", "json"],
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

      const res = runCli(["config", "set", "chunking.overlap", "2000", "--format", "json"], {
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
          args: nodeTsxArgs(["mcp", "--quiet"]),
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
          expect(call.content).toBeDefined();

          const textContent = (call.content as Array<any>).find(
            (item) => item.type === "text",
          );
          expect(textContent).toBeDefined();
          expect(JSON.parse(textContent.text).ok).toBe(true);

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
    20000,
  );
});

describe("HTTP MCP Server", () => {
  test(
    "serve refuses non-loopback binds without bearer auth",
    async () =>
      withTempLibraryPathAsync(async (libraryPath) => {
        const configPath = join(libraryPath, "config.json");
        writeTestConfig(configPath, libraryPath);

        const port = await getAvailablePort();
        const env = {
          ...process.env,
          ...envForConfig(configPath),
        } as Record<string, string>;
        delete env.POINK_SERVER_TOKEN;

        const proc = spawn(
          process.execPath,
          nodeTsxArgs([
            "serve",
            "--host",
            "0.0.0.0",
            "--port",
            String(port),
            "--quiet",
          ]),
          {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
            env,
          },
        );

        let stderr = "";
        let stdout = "";
        let timedOut = false;
        const rejectionTimeoutMs = 20_000;
        proc.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });

        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              timedOut = true;
              proc.kill();
            }, rejectionTimeoutMs);
            proc.once("exit", (code, signal) => {
              clearTimeout(timeout);
              if (timedOut) {
                reject(
                  new Error(
                    `serve did not reject unauthenticated remote bind within ${rejectionTimeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
                  ),
                );
                return;
              }
              resolve({ code, signal });
            });
          },
        );

        expect(exit.code).toBe(1);
        expect(exit.signal).toBeNull();
        expect(stderr).toContain("Refusing to bind HTTP MCP server");
      }),
    30000,
  );

  test(
    "serve starts the HTTP MCP server and exposes /health",
    async () =>
      withTempLibraryPathAsync(async (libraryPath) => {
        const configPath = join(libraryPath, "config.json");
        writeTestConfig(configPath, libraryPath);

        const port = await getAvailablePort();
        const proc = spawn(
          process.execPath,
          nodeTsxArgs([
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--quiet",
          ]),
          {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
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
            await sleep(100);
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
          await new Promise<void>((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) {
              resolve();
              return;
            }
            proc.once("exit", () => resolve());
          });
        }
      }),
    20000,
  );

  test(
    "serve enables bearer auth for non-loopback binds with env token",
    async () =>
      withTempLibraryPathAsync(async (libraryPath) => {
        const configPath = join(libraryPath, "config.json");
        writeTestConfig(configPath, libraryPath);

        const port = await getAvailablePort();
        const proc = spawn(
          process.execPath,
          nodeTsxArgs([
            "serve",
            "--host",
            "0.0.0.0",
            "--port",
            String(port),
            "--quiet",
          ]),
          {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              ...envForConfig(configPath),
              POINK_SERVER_TOKEN: "env-token",
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
            await sleep(100);
          }

          expect(health).toBeDefined();
          expect(health?.ok).toBe(true);

          const body = await health!.json();
          expect(body).toEqual({
            ok: true,
            host: "0.0.0.0",
            port,
            auth: { enabled: true },
          });

          const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`);
          expect(unauthorized.status).toBe(401);
        } finally {
          proc.kill();
          await new Promise<void>((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) {
              resolve();
              return;
            }
            proc.once("exit", () => resolve());
          });
        }
      }),
    20000,
  );
});
