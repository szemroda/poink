import { describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient } from "@libsql/client";
import { PDFDocument } from "pdf-lib";
import { removeDirWithRetries } from "./testUtils.js";

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
      libsql: { url: `file:${join(libraryPath, "library.db")}` },
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

type TimingMetadata = {
  totalMs: number;
  commandMs?: number;
};

function expectDuration(value: unknown): number {
  expect(typeof value).toBe("number");
  if (typeof value !== "number") {
    throw new Error("Expected duration to be a number");
  }
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  const fractionalDigits = String(value).split(".")[1]?.length ?? 0;
  expect(fractionalDigits).toBeLessThanOrEqual(3);
  return value;
}

function expectTimingMetadata(
  meta: unknown,
  options: { command: boolean },
): TimingMetadata {
  expect(meta).toBeDefined();
  if (typeof meta !== "object" || meta === null) {
    throw new Error("Expected metadata object");
  }
  const metaRecord = meta as Record<string, unknown>;
  expect(typeof metaRecord.poinkVersion).toBe("string");
  expect("timingMs" in metaRecord).toBe(false);
  expect("protocolVersion" in metaRecord).toBe(false);

  if (typeof metaRecord.timing !== "object" || metaRecord.timing === null) {
    throw new Error("Expected timing metadata object");
  }
  const timingRecord = metaRecord.timing as Record<string, unknown>;
  const totalMs = expectDuration(timingRecord.totalMs);

  if (!options.command) {
    expect("commandMs" in timingRecord).toBe(false);
    return { totalMs };
  }

  const commandMs = expectDuration(timingRecord.commandMs);
  expect(totalMs).toBeGreaterThanOrEqual(commandMs);
  return { totalMs, commandMs };
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
    await removeDirWithRetries(dir);
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

        const proc = spawnSync(process.execPath, ["dist/cli.js", "help", "--format", "json"], {
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
  test("page extract uses exact IDs and returns only published absolute paths", async () =>
    withTempLibraryPathAsync(async (libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const outputPath = join(libraryRoot, "exports");
      const sourcePath = join(libraryRoot, "source.pdf");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);
      const env = envForConfig(configPath);

      const pdf = await PDFDocument.create();
      pdf.addPage([200, 300]);
      pdf.addPage([300, 200]);
      const sourceBytes = await pdf.save();
      writeFileSync(sourcePath, sourceBytes);

      expect(runCli(["stats"], { env }).exitCode).toBe(0);
      const client = createClient({
        url: `file:${join(libraryPath, "library.db")}`,
      });
      await client.execute({
        sql: `INSERT INTO documents
                (id, title, path, added_at, page_count, size_bytes, tags,
                 metadata, file_type, source_hash_algorithm, source_hash)
              VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', 'pdf', 'sha256', ?)`,
        args: [
          "abc123-extra",
          "Stored PDF",
          sourcePath,
          "2026-01-01T00:00:00.000Z",
          2,
          sourceBytes.length,
          createHash("sha256").update(sourceBytes).digest("hex"),
        ],
      });
      client.close();

      const prefix = runCli(
        ["page", "extract", "abc123", "1", "--format", "json"],
        { env },
      );
      expect(prefix.exitCode).toBe(1);
      expect(JSON.parse(prefix.stdout).error.code).toBe("NOT_FOUND");

      const result = runCli(
        [
          "page",
          "extract",
          "abc123-extra",
          "2,1",
          "--output-dir",
          outputPath,
          "--format",
          "json",
        ],
        { env },
      );
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("page");
      expect(Object.keys(envelope.result).sort()).toEqual([
        "docId",
        "exportId",
        "files",
        "outputDirectory",
        "pages",
      ]);
      expect(envelope.result.docId).toBe("abc123-extra");
      expect(envelope.result.pages).toEqual([1, 2]);
      expect(envelope.result.outputDirectory).toBe(outputPath);
      expect(envelope.result.files).toHaveLength(1);
      expect(envelope.result.files[0]).toMatch(
        /^.*abc123-extra-[a-z0-9]{8}\.pdf$/,
      );
      expect(existsSync(envelope.result.files[0])).toBe(true);
      expect(envelope.result.files[0]).not.toContain(".stage");

      const text = runCli(
        [
          "page",
          "extract",
          "abc123-extra",
          "2",
          "--output-dir",
          outputPath,
        ],
        { env },
      );
      expect(text.exitCode).toBe(0);
      const lines = text.stdout.trim().split(/\r?\n/);
      expect(lines[0]).toBe("Exported pages: 2");
      expect(lines).toHaveLength(2);
      expect(existsSync(lines[1]!)).toBe(true);
    }));

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

  test("list is compact by default and retains legacy payload in verbose mode", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);
      const env = envForConfig(configPath);

      const compact = runCli(["list", "--format", "json"], { env });
      expect(compact.exitCode).toBe(0);
      expect(JSON.parse(compact.stdout).result).toEqual({ documents: [] });

      const verbose = runCli(["list", "--format", "json", "--verbose"], {
        env,
      });
      expect(verbose.exitCode).toBe(0);
      expect(JSON.parse(verbose.stdout).result).toEqual({
        tag: null,
        documents: [],
      });
    }));

  test("stats emits a minimal JSON envelope by default", () =>
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
      expect(obj.result).toBeDefined();
      expect(obj.result.libraryPath).toBe(libraryPath);
      expect(obj.result.documents).toBe(0);
      expect(obj.result.chunks).toBe(0);
      expect(obj.result.embeddings).toBe(0);
      expect(Object.keys(obj).sort()).toEqual(["command", "ok", "result"]);
    }));

  test("stats with --verbose includes timing metadata and nextActions", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["stats", "--format", "json", "--verbose"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("stats");
      expect("protocolVersion" in obj).toBe(false);
      const timing = expectTimingMetadata(obj.meta, { command: true });
      if (timing.commandMs === undefined) {
        throw new Error("Expected command timing");
      }
      expect(timing.totalMs - timing.commandMs).toBeGreaterThan(10);
      expect(Array.isArray(obj.nextActions)).toBe(true);
      expect(obj.nextActions.length).toBeGreaterThan(0);
    }));

  test("verbose text output does not expose timing metadata", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);
      const env = envForConfig(configPath);

      const compact = runCli(["stats", "--format", "text"], { env });
      const verbose = runCli(["stats", "--format", "text", "--verbose"], {
        env,
      });

      expect(verbose.exitCode).toBe(0);
      expect(verbose.stdout).toBe(compact.stdout);
      expect(verbose.stdout).not.toContain("timing");
    }));

  test("removed hint flags are rejected", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      for (const flag of ["--quiet", "--no-hints"]) {
        const res = runCli(["stats", flag, "--format", "json"], {
          env: envForConfig(configPath),
        });
        expect(res.exitCode).not.toBe(0);
        expect(JSON.parse(res.stdout).error.code).toBe("INVALID_FLAG");
      }
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

  test("root-level --format is rejected by default", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["--format", "json", "stats"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("INVALID_FLAG");
      expect(res.stderr).toContain("unknown option");
    }));

  test("root-level --format returns a structured error envelope when configured for JSON", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath, "ollama", "json");

      const res = runCli(["--format", "text", "stats"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.error).toBeDefined();
      expect(obj.error.code).toBe("INVALID_FLAG");
      expect(Object.keys(obj).sort()).toEqual(["command", "error", "ok"]);
    }));

  test("unknown command option returns a structured INVALID_FLAG envelope", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["stats", "--bogus", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.command).toBe("stats");
      expect(obj.error.code).toBe("INVALID_FLAG");
      expect(String(obj.error.message)).toContain("--bogus");
    }));

  test("verbose parse errors include timing metadata", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        ["stats", "--bogus", "--format", "json", "--verbose"],
        { env: envForConfig(configPath) },
      );

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect("protocolVersion" in obj).toBe(false);
      expectTimingMetadata(obj.meta, { command: false });
    }));

  test("verbose command failures include command timing", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        ["read", "missing-document", "--format", "json", "--verbose"],
        { env: envForConfig(configPath) },
      );

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.error.code).toBe("NOT_FOUND");
      expectTimingMetadata(obj.meta, { command: true });
    }));

  test("missing required command argument returns a structured INVALID_ARGS envelope", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["search", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.command).toBe("search");
      expect(obj.error.code).toBe("INVALID_ARGS");
      expect(String(obj.error.message)).toContain("query");
    }));

  test("search omits echoed input by default and restores it in verbose mode", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);
      const env = envForConfig(configPath);

      const compact = runCli(
        ["search", "absent", "--fts", "--docs-only", "--format", "json"],
        { env },
      );
      expect(compact.exitCode).toBe(0);
      expect(JSON.parse(compact.stdout).result).toEqual({
        retrievalMode: "fts",
        concepts: [],
        documents: [],
      });

      const verbose = runCli(
        ["search", "absent", "--fts", "--docs-only", "--format", "json", "--verbose"],
        { env },
      );
      expect(verbose.exitCode).toBe(0);
      const result = JSON.parse(verbose.stdout).result;
      expect(result.query).toBe("absent");
      expect(result.retrievalMode).toBe("fts");
      expect(result.options.ftsOnly).toBe(true);
      expect(result.concepts).toEqual([]);
      expect(result.documents).toEqual([]);
    }));

  test("search-pack omits echoed top-level input by default", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);
      const env = envForConfig(configPath);

      const compact = runCli(
        ["search-pack", "absent", "--fts", "--format", "json"],
        { env },
      );
      expect(compact.exitCode).toBe(0);
      const compactResult = JSON.parse(compact.stdout).result;
      expect(Object.keys(compactResult).sort()).toEqual([
        "deduped",
        "perQuery",
        "retrievalMode",
      ]);
      expect(compactResult.retrievalMode).toBe("fts");
      expect(compactResult.perQuery[0]).toEqual({
        query: "absent",
        documents: [],
      });

      const verbose = runCli(
        [
          "search-pack",
          "absent",
          "--fts",
          "--format",
          "json",
          "--verbose",
        ],
        { env },
      );
      expect(verbose.exitCode).toBe(0);
      const verboseResult = JSON.parse(verbose.stdout).result;
      expect(verboseResult.queries).toEqual(["absent"]);
      expect(verboseResult.retrievalMode).toBe("fts");
      expect(verboseResult.options.ftsOnly).toBe(true);
    }));

  test("semantic search reports provider failure instead of falling back to FTS", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(
        [
          "search",
          "absent",
          "--docs-only",
          "--format",
          "json",
          "--verbose",
        ],
        { env: envForConfig(configPath) },
      );

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.command).toBe("search");
      expect(obj.error.code).toBe("PROVIDER_NOT_READY");
      expect(obj.error.details).toMatchObject({
        provider: "ollama",
        requestedRetrievalMode: "hybrid",
      });
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

  test(
    "source integrity drives rechunk planning and deep doctor without exposing hashes",
    async () =>
      withTempLibraryPathAsync(async (libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      const sourcePath = join(libraryPath, "source.md");
      writeTestConfig(configPath, libraryPath);
      writeFileSync(sourcePath, "# Source\n\noriginal\n");
      const env = envForConfig(configPath);

      expect(runCli(["stats", "--format", "json"], { env }).exitCode).toBe(0);

      const db = createClient({
        url: `file:${join(libraryPath, "library.db")}`,
      });
      const chunker = {
        id: "markdown-extractor:shared-context-v3",
        version: 3,
        unit: "chars",
        chunkSize: 2000,
        chunkOverlap: 200,
      };
      await db.execute({
        sql: `INSERT INTO documents
                (id, title, path, added_at, page_count, size_bytes, tags,
                 file_type, metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "doc-1",
          "Source",
          sourcePath,
          "2026-01-01T00:00:00.000Z",
          1,
          Buffer.byteLength("# Source\n\noriginal\n"),
          "[]",
          "markdown",
          JSON.stringify({ chunker }),
        ],
      });
      db.close();

      const bulk = JSON.parse(
        runCli(["rechunk", "--dry-run", "--format", "json"], { env }).stdout,
      );
      expect(bulk.result.planned).toBe(0);
      expect(bulk.result.skippedMissing).toBe(1);

      const includeMissing = JSON.parse(
        runCli(
          [
            "rechunk",
            "--dry-run",
            "--include-missing",
            "--format",
            "json",
          ],
          { env },
        ).stdout,
      );
      expect(includeMissing.result.planned).toBe(1);
      expect(includeMissing.result.docs[0].code).toBe("missing_identity");

      const explicitMissing = JSON.parse(
        runCli(
          ["rechunk", "--dry-run", "--doc", "doc-1", "--format", "json"],
          { env },
        ).stdout,
      );
      expect(explicitMissing.result.planned).toBe(1);

      const sourceHash = createHash("sha256")
        .update(readFileSync(sourcePath))
        .digest("hex");
      const identityDb = createClient({
        url: `file:${join(libraryPath, "library.db")}`,
      });
      await identityDb.execute({
        sql: `UPDATE documents
              SET source_hash_algorithm = 'sha256', source_hash = ?
              WHERE id = 'doc-1'`,
        args: [sourceHash],
      });
      identityDb.close();

      writeFileSync(sourcePath, "# Source\n\nchanged\n");

      const explicitChanged = JSON.parse(
        runCli(
          ["rechunk", "--dry-run", "--doc", "doc-1", "--format", "json"],
          { env },
        ).stdout,
      );
      expect(explicitChanged.result.docs[0].code).toBe("source_changed");
      expect(JSON.stringify(explicitChanged)).not.toContain(sourceHash);
      expect(JSON.stringify(explicitChanged)).not.toContain("sha256");

      const normalDoctor = JSON.parse(
        runCli(["doctor", "--format", "json"], { env }).stdout,
      );
      expect(normalDoctor.result.sourceIntegrity.checked).toBe(0);
      expect(normalDoctor.result.sourceIntegrity.changed).toBe(0);

      const deepDoctor = JSON.parse(
        runCli(["doctor", "--deep", "--format", "json"], { env }).stdout,
      );
      expect(deepDoctor.result.sourceIntegrity.checked).toBe(1);
      expect(deepDoctor.result.sourceIntegrity.changed).toBe(1);
      expect(deepDoctor.result.sourceIntegrity.sample[0]).toMatchObject({
        id: "doc-1",
        title: "Source",
        codes: ["source_changed"],
      });
      expect(JSON.stringify(deepDoctor)).not.toContain(sourceHash);
      expect(JSON.stringify(deepDoctor)).not.toContain("sha256");
      expect(JSON.stringify(deepDoctor)).not.toContain(sourcePath);
      }),
    60_000,
  );

  test("capabilities is self-describing without embedding JSON Schemas", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["capabilities", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("capabilities");

      const result = obj.result;
      expect(result).toBeDefined();
      expect(typeof result.poinkVersion).toBe("string");
      expect(result.outputFormats).toEqual(["text", "json", "ndjson"]);
      expect(result.globalFlags["--verbose"]).toBeDefined();
      expect(result.globalFlags["--quiet"]).toBeUndefined();
      expect(result.globalFlags["--no-hints"]).toBeUndefined();
      expect("defaultFormat" in result).toBe(false);
      expect("factoryDefaultFormat" in result).toBe(false);
      expect("configurableDefaultFormat" in result).toBe(false);

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
      expect(commandNames.has("setup")).toBe(false);
      const providersCommand = (result.commands as Array<any>).find(
        (c) => c.name === "providers",
      );
      expect(providersCommand?.argv).toEqual([
        "providers",
        "login",
        "--provider",
        "openai-codex",
        "--format",
        "text",
        "[--device-auth]",
      ]);

      expect("schemas" in result).toBe(false);
    }));

  test("config schema exposes the config schema outside capabilities", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const fetched = runCli(["config", "schema", "--format", "json"], {
        env: envForConfig(configPath),
      });
      expect(fetched.exitCode).toBe(0);
      const schema = JSON.parse(fetched.stdout).result;
      expect(schema.type).toBe("object");
      expect(schema.properties.models).toBeDefined();
      expect(schema.properties.providers).toBeDefined();
      expect(schema.properties.storage).toBeDefined();
      expect(schema.properties.storage.properties.libsql).toBeDefined();
      expect(schema.properties.storage.properties.backend).toBeUndefined();
      expect(schema.properties.storage.properties.qdrant).toBeUndefined();
    }));

  test("taxonomy list is compact and taxonomy get returns details", async () =>
    withTempLibraryPathAsync(async (libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);
      const env = envForConfig(configPath);

      expect(runCli(["stats", "--format", "json"], { env }).exitCode).toBe(0);
      const db = createClient({
        url: `file:${join(libraryPath, "library.db")}`,
      });
      try {
        await db.batch(
          [
            {
              sql: `INSERT INTO concepts
                    (id, pref_label, alt_labels, definition, created_at)
                    VALUES (?, ?, ?, ?, ?)`,
              args: [
                "programming",
                "Programming",
                "[]",
                "Software development and programming topics",
                "2026-01-01T00:00:00.000Z",
              ],
            },
            {
              sql: `INSERT INTO concepts
                    (id, pref_label, alt_labels, definition, created_at)
                    VALUES (?, ?, ?, ?, ?)`,
              args: [
                "programming/typescript",
                "TypeScript",
                "[\"TS\"]",
                "TypeScript language and ecosystem",
                "2026-01-01T00:00:00.000Z",
              ],
            },
            {
              sql: `INSERT INTO concept_hierarchy (concept_id, broader_id)
                    VALUES (?, ?)`,
              args: ["programming/typescript", "programming"],
            },
          ],
          "write",
        );
      } finally {
        await db.close();
      }

      const listed = runCli(["taxonomy", "list", "--format", "json"], {
        env,
      });
      expect(listed.exitCode).toBe(0);
      const concepts = JSON.parse(listed.stdout).result.concepts;
      expect(concepts).toContainEqual({
        id: "programming",
        prefLabel: "Programming",
      });
      expect(concepts[0]).not.toHaveProperty("definition");
      expect(concepts[0]).not.toHaveProperty("createdAt");

      const verboseList = runCli(
        ["taxonomy", "list", "--format", "json", "--verbose"],
        { env },
      );
      expect(verboseList.exitCode).toBe(0);
      const verboseConcepts = JSON.parse(verboseList.stdout).result.concepts;
      expect(verboseConcepts[0]).toHaveProperty("altLabels");
      expect(verboseConcepts[0]).not.toHaveProperty("createdAt");

      const removedTreeFlag = runCli(
        ["taxonomy", "list", "--tree", "--format", "json"],
        { env },
      );
      expect(removedTreeFlag.exitCode).not.toBe(0);
      expect(JSON.parse(removedTreeFlag.stdout).error.code).toBe("INVALID_FLAG");

      const fetched = runCli(
        ["taxonomy", "get", "programming/typescript", "--format", "json"],
        { env },
      );
      expect(fetched.exitCode).toBe(0);
      const detail = JSON.parse(fetched.stdout).result;
      expect(detail.id).toBe("programming/typescript");
      expect(detail.definition).toBe("TypeScript language and ecosystem");
      expect(detail.broader).toEqual([
        { id: "programming", prefLabel: "Programming" },
      ]);
      expect(detail.narrower).toEqual([]);
      expect(detail.related).toEqual([]);
      expect(detail).not.toHaveProperty("createdAt");

      const tree = runCli(["taxonomy", "tree", "--format", "json"], { env });
      expect(tree.exitCode).toBe(0);
      const root = JSON.parse(tree.stdout).result.tree[0];
      expect(root).not.toHaveProperty("concept");
      const programmingRoot = JSON.parse(tree.stdout).result.tree.find(
        (node: any) => node.id === "programming",
      );
      expect(programmingRoot.children).toContainEqual(
        expect.objectContaining({
          id: "programming/typescript",
          prefLabel: "TypeScript",
        }),
      );
      await sleep(250);
    }));

  test("setup lists available subcommands without running the wizard", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["setup", "--format", "text"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Usage: poink setup <command>");
      expect(res.stdout).toContain("Initialize Poink and run the configuration wizard");
      expect(res.stdout).toContain("Run the configuration wizard for an initialized library");
    }));

  test("setup interactive commands require text format, including dry-run", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      for (const argv of [
        ["setup", "init", "--format", "json"],
        ["setup", "config", "--format", "json"],
        ["setup", "init", "--dry-run", "--format", "json"],
        ["setup", "config", "--dry-run", "--format", "json"],
      ]) {
        const res = runCli(argv, {
          env: envForConfig(configPath),
        });

        expect(res.exitCode).not.toBe(0);
        const obj = JSON.parse(res.stdout);
        expect(obj.ok).toBe(false);
        expect(obj.command).toBe("setup");
        expect(obj.error.code).toBe("INVALID_ARGS");
        expect(String(obj.error.message)).toContain("--format text");
      }
    }));

  test("setup config fails before prompting when library is not initialized", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "missing-library");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["setup", "config", "--format", "text"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain("NOT_INITIALIZED");
      expect(res.stderr).toContain("poink setup init");
    }));

  test("capabilities does not expose configured default format", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath, "ollama", "ndjson");

      const res = runCli(["capabilities", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect("defaultFormat" in obj.result).toBe(false);
      expect("factoryDefaultFormat" in obj.result).toBe(false);
      expect("configurableDefaultFormat" in obj.result).toBe(false);
    }));

  test("providers login requires text format because it is interactive", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["providers", "login", "--provider", "openai-codex", "--format", "json", "--verbose"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).not.toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(false);
      expect(obj.command).toBe("providers");
      expect(obj.error.code).toBe("INVALID_ARGS");
      expect(String(obj.error.message)).toContain("--format text");
      expect(obj.error.details.hint).toBe(
        "poink providers login --provider openai-codex --format text",
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
          "--verbose",
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

      for (const command of ["config", "providers", "setup"]) {
        const res = runCli([command, "--help", "--format", "json"], {
          env: envForConfig(configPath),
        });

        expect(res.exitCode).toBe(0);
        const obj = JSON.parse(res.stdout);
        expect(obj.ok).toBe(true);
        expect(obj.command).toBe("help");
        expect(obj.result.help).toContain(
          "poink providers login --provider openai-codex --format text",
        );
        expect(obj.result.help).toContain("poink setup init --format text");
      }
    }));

  test("config show text output includes libSQL database details", () =>
    withTempLibraryPath((libraryPath) => {
      const configPath = join(libraryPath, "config.json");
      writeTestConfig(configPath, libraryPath);

      const res = runCli(["config", "show", "--format", "text"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Storage:");
      expect(res.stdout).toContain("libSQL");
      expect(res.stdout).toContain("Database:");
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
      config.server.auth.token = "server-secret";
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      const res = runCli(["config", "show", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain("openrouter-secret");
      expect(res.stdout).not.toContain("libsql-secret");
      expect(res.stdout).not.toContain("server-secret");

      const obj = JSON.parse(res.stdout);
      expect(obj.result.config.providers.openrouter.apiKey).toBe("[redacted]");
      expect(obj.result.config.storage.libsql.authToken).toBe("[redacted]");
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

      const res = runCli(["init", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);

      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("init");
      expect(obj.result.libraryPath).toBe(libraryPath);
      expect(obj.result.dbPath).toBe(join(libraryPath, "library.db"));
    }));

  test("ingest with JSON output emits a single machine-readable envelope", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const emptyDocs = join(libraryRoot, "empty-docs");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);
      mkdirSync(emptyDocs);

      const res = runCli(["ingest", emptyDocs, "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("ingest");
      expect(obj.result.foundFiles).toBe(0);
    }));

  test("ingest --no-recursive does not scan nested directories", () =>
    withTempLibraryPath((libraryRoot) => {
      const libraryPath = join(libraryRoot, "library");
      const docs = join(libraryRoot, "docs");
      const nested = join(docs, "nested");
      const configPath = join(libraryRoot, "config.json");
      writeTestConfig(configPath, libraryPath);
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "note.md"), "# Nested note\n\nNot discovered.", "utf-8");

      const res = runCli(["ingest", docs, "--no-recursive", "--format", "json"], {
        env: envForConfig(configPath),
      });

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.ok).toBe(true);
      expect(obj.command).toBe("ingest");
      expect(obj.result.foundFiles).toBe(0);
    }));

  test("CLI package dependencies do not include Ink or React", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    expect(pkg.dependencies?.ink).toBeUndefined();
    expect(pkg.dependencies?.["ink-spinner"]).toBeUndefined();
    expect(pkg.dependencies?.react).toBeUndefined();
    expect(pkg.devDependencies?.["@types/react"]).toBeUndefined();
  });

  test("commander refactor has concrete module entrypoints for planned CLI domains", () => {
    for (const path of [
      "src/cli/mcp.ts",
      "src/cli/serve.ts",
      "src/cli/runtime.ts",
      "src/cli/envelope.ts",
      "src/cli/health.ts",
      "src/cli/ingestProgress.ts",
      "src/cli/commands/capabilities.ts",
      "src/cli/commands/add.ts",
      "src/cli/commands/search.ts",
      "src/cli/commands/taxonomy.ts",
      "src/cli/commands/doctor.ts",
      "src/cli/commands/init.ts",
      "src/cli/commands/setup.ts",
      "src/cli/commands/repair.ts",
      "src/cli/commands/ingest.ts",
      "src/cli/commands/reindex.ts",
      "src/cli/commands/rechunk.ts",
      "src/cli/families/lightweight.ts",
      "src/cli/families/store.ts",
      "src/cli/families/search.ts",
      "src/cli/families/ingestion.ts",
      "src/cli/families/setup.ts",
      "src/cli/families/diagnostics.ts",
      "src/cli/families/server.ts",
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
  });
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
          args: nodeTsxArgs(["mcp"]),
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
          expect(toolNames.has("config_schema")).toBe(true);
          expect(toolNames.has("stats")).toBe(true);
          expect(toolNames.has("search")).toBe(true);
          expect(toolNames.has("taxonomy_get")).toBe(true);

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
          expect(envelope.result).toBeDefined();
          expect(envelope.result.libraryPath).toBe(libraryPath);
          expect("protocolVersion" in envelope).toBe(false);
          expect("meta" in envelope).toBe(false);
          expect(JSON.parse(textContent.text)).toEqual(envelope);

          const ftsSearchCall = await client.callTool({
            name: "search",
            arguments: {
              query: "absent",
              docsOnly: true,
              fts: true,
            },
          });
          const ftsSearchEnvelope =
            ftsSearchCall.structuredContent as Record<string, unknown>;
          expect(ftsSearchEnvelope.ok).toBe(true);
          expect(ftsSearchEnvelope.result).toMatchObject({
            retrievalMode: "fts",
            documents: [],
          });

          const semanticSearchCall = await client.callTool({
            name: "search",
            arguments: {
              query: "absent",
              docsOnly: true,
            },
          });
          const semanticSearchEnvelope =
            semanticSearchCall.structuredContent as Record<string, unknown>;
          expect(semanticSearchCall.isError).toBe(true);
          expect(semanticSearchEnvelope.ok).toBe(false);
          expect(semanticSearchEnvelope.error).toMatchObject({
            code: "PROVIDER_NOT_READY",
          });
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

  test(
    "verbose MCP errors include timing metadata",
    async () =>
      withTempLibraryPathAsync(async (libraryPath) => {
        const configPath = join(libraryPath, "config.json");
        writeTestConfig(configPath, libraryPath);

        const transport = new StdioClientTransport({
          command: process.execPath,
          args: nodeTsxArgs(["mcp", "--verbose"]),
          cwd: process.cwd(),
          stderr: "pipe",
          env: Object.fromEntries(
            Object.entries({
              ...process.env,
              ...envForConfig(configPath),
            }).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
        });
        const client = new Client({
          name: "poink-verbose-error-test",
          version: "0.0.0",
        });

        try {
          await client.connect(transport);
          const successCall = await client.callTool({
            name: "stats",
            arguments: {},
          });
          const successEnvelope =
            successCall.structuredContent as Record<string, unknown>;
          expect(successEnvelope.ok).toBe(true);
          expect("protocolVersion" in successEnvelope).toBe(false);
          expectTimingMetadata(successEnvelope.meta, { command: true });

          const call = await client.callTool({
            name: "read",
            arguments: { idOrTitle: "missing-document" },
          });
          const envelope = call.structuredContent as Record<string, unknown>;

          expect(envelope.ok).toBe(false);
          expect("protocolVersion" in envelope).toBe(false);
          expectTimingMetadata(envelope.meta, { command: true });
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
    "verbose serve startup failures include total timing only",
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

        const proc = spawnSync(
          process.execPath,
          nodeTsxArgs([
            "serve",
            "--host",
            "0.0.0.0",
            "--port",
            String(port),
            "--format",
            "json",
            "--verbose",
          ]),
          {
            cwd: process.cwd(),
            encoding: "utf-8",
            env,
          },
        );

        expect(proc.status).toBe(1);
        expect(proc.stderr).toBe("");
        const obj = JSON.parse(proc.stdout);
        expect(obj.ok).toBe(false);
        expect(obj.command).toBe("serve");
        expect("protocolVersion" in obj).toBe(false);
        expectTimingMetadata(obj.meta, { command: false });
        expect(obj.error.code).toBe("INVALID_CONFIG");
        expect(String(obj.error.message)).toContain("Refusing to bind HTTP MCP server");
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
