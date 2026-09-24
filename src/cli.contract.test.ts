import { describe, expect, test as baseTest } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient } from "@libsql/client";
import { PDFDocument } from "pdf-lib";
import { removeDirWithRetries } from "./testUtils.js";

type CliResult = { exitCode: number; stdout: string; stderr: string };
type RunOptions = { cwd?: string; env?: Record<string, string | undefined> };
type OutputFormat = "json" | "ndjson" | "text";

type TestConfigOptions = {
  modelProvider?: "ollama" | "openrouter";
  format?: OutputFormat;
  ingest?: { include?: string[]; exclude?: string[] };
  secrets?: {
    openrouterApiKey?: string;
    libsqlAuthToken?: string;
    serverToken?: string;
  };
};

/** A temp directory holding `config.json`; the library lives in it or in `librarySubdir`. */
type TestLibrary = {
  root: string;
  libraryPath: string;
  configPath: string;
  env: Record<string, string>;
  /** Runs the CLI with this library's config. */
  run: (argv: string[], options?: RunOptions) => CliResult;
};

function nodeTsxArgs(args: string[]): string[] {
  return ["--import", import.meta.resolve("tsx"), resolve("src/cli.ts"), ...args];
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function modelsFor(provider: "ollama" | "openrouter") {
  if (provider === "openrouter") {
    const language = { provider, model: "anthropic/claude-3.5-haiku" };
    return {
      embedding: { provider, model: "openai/text-embedding-3-small" },
      enrichment: language,
      judge: language,
    };
  }
  const language = { provider, model: "llama3.2:3b" };
  return {
    embedding: { provider, model: "mxbai-embed-large" },
    enrichment: language,
    judge: language,
  };
}

// Ollama points at an unreachable port so semantic paths fail fast with PROVIDER_NOT_READY.
function makeTestConfig(libraryPath: string, options: TestConfigOptions) {
  return {
    version: 1,
    library: { path: libraryPath },
    chunking: { strategy: "text", size: 2000, overlap: 200 },
    cli: { globalFlags: { format: options.format ?? "text" } },
    ingest: {
      include: options.ingest?.include ?? [],
      exclude: options.ingest?.exclude ?? [],
      urlDownloads: {
        maxFileSize: "100mb",
        timeout: "30s",
        maxRedirects: 5,
        allowPrivateNetwork: false,
        allowedPrivateNetworkHosts: [],
      },
    },
    models: modelsFor(options.modelProvider ?? "ollama"),
    providers: {
      ollama: { baseUrl: "http://127.0.0.1:1", autoPull: true },
      gateway: { apiKeyEnv: "AI_GATEWAY_API_KEY" },
      openai: {
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
      },
      openrouter: {
        apiKeyEnv: "OPENROUTER_API_KEY",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: options.secrets?.openrouterApiKey,
      },
    },
    storage: {
      libsql: {
        url: `file:${join(libraryPath, "library.db")}`,
        authToken: options.secrets?.libsqlAuthToken,
      },
    },
    server: {
      host: "127.0.0.1",
      port: 3838,
      auth: {
        enabled: false,
        tokenEnv: "POINK_SERVER_TOKEN",
        token: options.secrets?.serverToken,
      },
    },
  };
}

function childEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function runCli(argv: string[], options: RunOptions = {}): CliResult {
  const proc = spawnSync(process.execPath, nodeTsxArgs(argv), {
    cwd: options.cwd,
    env: childEnv(options.env),
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (proc.error) throw proc.error;
  return { exitCode: proc.status ?? 1, stdout: proc.stdout, stderr: proc.stderr };
}

function setupLibrary(
  root: string,
  options: TestConfigOptions & { librarySubdir?: string } = {},
): TestLibrary {
  const libraryPath =
    options.librarySubdir === undefined ? root : join(root, options.librarySubdir);
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(makeTestConfig(libraryPath, options), null, 2),
    "utf-8",
  );
  const env = { POINK_CONFIG: configPath, POINK_LOG_LEVEL: "silent" };
  return {
    root,
    libraryPath,
    configPath,
    env,
    run: (argv, runOptions) =>
      runCli(argv, { cwd: runOptions?.cwd, env: { ...env, ...runOptions?.env } }),
  };
}

// `tmp` is a fresh temp dir; `lib` is a default-configured library inside it.
const test = baseTest.extend<{ tmp: string; lib: TestLibrary }>({
  tmp: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "poink-cli-contract-"));
    await use(dir);
    await removeDirWithRetries(dir);
  },
  lib: async ({ tmp }, use) => {
    await use(setupLibrary(tmp));
  },
});

function readSavedConfig(lib: TestLibrary): unknown {
  return JSON.parse(readFileSync(lib.configPath, "utf-8"));
}

function valueAtPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function openLibraryDb(libraryPath: string) {
  return createClient({ url: `file:${join(libraryPath, "library.db")}` });
}

type StoredDocument = {
  id: string;
  title: string;
  path: string;
  pageCount: number;
  sizeBytes: number;
  fileType: "markdown" | "pdf";
  metadata?: Record<string, unknown>;
  sourceHash?: string;
};

/** Initializes the library schema via the CLI, then inserts a document row directly. */
async function seedDocument(lib: TestLibrary, doc: StoredDocument): Promise<void> {
  expect(lib.run(["stats"]).exitCode).toBe(0);
  const db = openLibraryDb(lib.libraryPath);
  try {
    await db.execute({
      sql: `INSERT INTO documents
              (id, title, path, added_at, page_count, size_bytes, tags,
               file_type, metadata, source_hash_algorithm, source_hash)
            VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?, ?, '[]', ?, ?, ?, ?)`,
      args: [
        doc.id,
        doc.title,
        doc.path,
        doc.pageCount,
        doc.sizeBytes,
        doc.fileType,
        JSON.stringify(doc.metadata ?? {}),
        doc.sourceHash === undefined ? null : "sha256",
        doc.sourceHash ?? null,
      ],
    });
  } finally {
    db.close();
  }
}

function expectDuration(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error(`Expected a duration, got ${String(value)}`);
  }
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(String(value).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3);
  return value;
}

/** Asserts verbose `meta` holds the version and millisecond timings (at most 3 decimals). */
function expectTimingMetadata(
  meta: unknown,
  options: { command: boolean },
): { totalMs: number; commandMs?: number } {
  const duration = expect.any(Number);
  expect(meta).toStrictEqual({
    poinkVersion: expect.any(String),
    timing: options.command
      ? { totalMs: duration, commandMs: duration }
      : { totalMs: duration },
  });
  if (!isRecord(meta) || !isRecord(meta.timing)) {
    throw new Error("Expected timing metadata");
  }

  const totalMs = expectDuration(meta.timing.totalMs);
  if (!options.command) return { totalMs };

  const commandMs = expectDuration(meta.timing.commandMs);
  expect(totalMs).toBeGreaterThanOrEqual(commandMs);
  return { totalMs, commandMs };
}

describe("Node Build Smoke", () => {
  test(
    "dist CLI runs with node",
    ({ lib }) => {
      // npm is a .cmd shim on Windows, which Node only spawns through a shell.
      const build = spawnSync("npm run build", { encoding: "utf-8", shell: true });
      if (build.error) throw build.error;
      if (build.status !== 0) throw new Error(build.stderr || build.stdout);

      const proc = spawnSync(
        process.execPath,
        ["dist/cli.js", "help", "--format", "json"],
        { env: childEnv(lib.env), encoding: "utf-8" },
      );

      expect(proc.status).toBe(0);
      expect(JSON.parse(proc.stdout)).toMatchObject({ ok: true, command: "help" });
    },
    60_000,
  );
});

describe("CLI JSON Envelope Contract", () => {
  test("page extract uses exact IDs and returns only published absolute paths", async ({ lib }) => {
    const outputPath = join(lib.root, "exports");
    const sourcePath = join(lib.root, "source.pdf");
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 300]);
    pdf.addPage([300, 200]);
    const sourceBytes = await pdf.save();
    writeFileSync(sourcePath, sourceBytes);
    await seedDocument(lib, {
      id: "abc123-extra",
      title: "Stored PDF",
      path: sourcePath,
      pageCount: 2,
      sizeBytes: sourceBytes.length,
      fileType: "pdf",
      sourceHash: createHash("sha256").update(sourceBytes).digest("hex"),
    });

    const prefix = lib.run(["page", "extract", "abc123", "1", "--format", "json"]);
    expect(prefix.exitCode).toBe(1);
    expect(JSON.parse(prefix.stdout).error.code).toBe("NOT_FOUND");

    const json = lib.run([
      "page", "extract", "abc123-extra", "2,1",
      "--output-dir", outputPath, "--format", "json",
    ]);
    expect(json.exitCode).toBe(0);
    const envelope = JSON.parse(json.stdout);
    expect(envelope).toStrictEqual({
      ok: true,
      command: "page",
      result: {
        docId: "abc123-extra",
        exportId: expect.any(String),
        pages: [1, 2],
        outputDirectory: outputPath,
        files: [expect.stringMatching(/abc123-extra-[a-z0-9]{8}\.pdf$/)],
      },
    });
    const [file] = envelope.result.files;
    expect(isAbsolute(file)).toBe(true);
    expect(file).not.toContain(".stage");
    expect(existsSync(file)).toBe(true);

    const text = lib.run([
      "page", "extract", "abc123-extra", "2", "--output-dir", outputPath,
    ]);
    expect(text.exitCode).toBe(0);
    const lines = text.stdout.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Exported pages: 2");
    expect(existsSync(lines[1]!)).toBe(true);
  });

  test("stats emits text output by default", ({ lib }) => {
    const res = lib.run(["stats"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("PDF Library Stats");
    expect(res.stdout).toContain("Documents:  0");
  });

  test("list is compact by default and retains legacy payload in verbose mode", ({ lib }) => {
    const compact = lib.run(["list", "--format", "json"]);
    expect(compact.exitCode).toBe(0);
    expect(JSON.parse(compact.stdout).result).toEqual({ documents: [] });

    const verbose = lib.run(["list", "--format", "json", "--verbose"]);
    expect(verbose.exitCode).toBe(0);
    expect(JSON.parse(verbose.stdout).result).toEqual({ tag: null, documents: [] });
  });

  test("stats emits a minimal JSON envelope by default", ({ lib }) => {
    const res = lib.run(["stats", "--format", "json"]);

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toStrictEqual({
      ok: true,
      command: "stats",
      result: expect.objectContaining({
        libraryPath: lib.libraryPath,
        documents: 0,
        chunks: 0,
        embeddings: 0,
      }),
    });
  });

  test("stats with --verbose includes timing metadata and nextActions", ({ lib }) => {
    const res = lib.run(["stats", "--format", "json", "--verbose"]);

    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout);
    expect(obj).toMatchObject({ ok: true, command: "stats" });
    expect(Object.keys(obj).sort()).toEqual(["command", "meta", "nextActions", "ok", "result"]);
    const timing = expectTimingMetadata(obj.meta, { command: true });
    if (timing.commandMs === undefined) throw new Error("Expected command timing");
    // Total timing covers process startup, not just the command body.
    expect(timing.totalMs - timing.commandMs).toBeGreaterThan(10);
    expect(Array.isArray(obj.nextActions)).toBe(true);
    expect(obj.nextActions.length).toBeGreaterThan(0);
  });

  test("verbose text output does not expose timing metadata", ({ lib }) => {
    const compact = lib.run(["stats", "--format", "text"]);
    const verbose = lib.run(["stats", "--format", "text", "--verbose"]);

    expect(verbose.exitCode).toBe(0);
    expect(verbose.stdout).toBe(compact.stdout);
    expect(verbose.stdout).not.toContain("timing");
  });

  test("configured default format applies unless --format overrides it", ({ tmp }) => {
    const lib = setupLibrary(tmp, { format: "json" });

    const configured = lib.run(["stats"]);
    expect(configured.exitCode).toBe(0);
    expect(JSON.parse(configured.stdout)).toMatchObject({ ok: true, command: "stats" });

    const overridden = lib.run(["stats", "--format", "text"]);
    expect(overridden.exitCode).toBe(0);
    expect(overridden.stdout).toContain("PDF Library Stats");
    expect(() => JSON.parse(overridden.stdout)).toThrow();
  });

  test("root-level --format is rejected by default", ({ lib }) => {
    const res = lib.run(["--format", "json", "stats"]);

    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("INVALID_FLAG");
    expect(res.stderr).toContain("unknown option");
  });

  test("root-level --format returns a structured error envelope when configured for JSON", ({ tmp }) => {
    const lib = setupLibrary(tmp, { format: "json" });

    const res = lib.run(["--format", "text", "stats"]);

    expect(res.exitCode).not.toBe(0);
    const obj = JSON.parse(res.stdout);
    expect(Object.keys(obj).sort()).toEqual(["command", "error", "ok"]);
    expect(obj).toMatchObject({ ok: false, error: { code: "INVALID_FLAG" } });
  });

  test("unknown command option returns a structured INVALID_FLAG envelope", ({ lib }) => {
    const res = lib.run(["stats", "--bogus", "--format", "json"]);

    expect(res.exitCode).not.toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: false,
      command: "stats",
      error: { code: "INVALID_FLAG", message: expect.stringContaining("--bogus") },
    });
  });

  test("verbose parse errors include timing metadata", ({ lib }) => {
    const res = lib.run(["stats", "--bogus", "--format", "json", "--verbose"]);

    expect(res.exitCode).not.toBe(0);
    expectTimingMetadata(JSON.parse(res.stdout).meta, { command: false });
  });

  test("verbose command failures include command timing", ({ lib }) => {
    const res = lib.run(["read", "missing-document", "--format", "json", "--verbose"]);

    expect(res.exitCode).not.toBe(0);
    const obj = JSON.parse(res.stdout);
    expect(obj).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(Object.keys(obj).sort()).toEqual(["command", "error", "meta", "ok"]);
    expectTimingMetadata(obj.meta, { command: true });
  });

  test("missing required command argument returns a structured INVALID_ARGS envelope", ({ lib }) => {
    const res = lib.run(["search", "--format", "json"]);

    expect(res.exitCode).not.toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: false,
      command: "search",
      error: { code: "INVALID_ARGS", message: expect.stringContaining("query") },
    });
  });

  test.for([
    { command: "search", args: ["--limit", "invalid", "--", "--help"] },
    { command: "search", args: ["--limit", "invalid", "--tag", "--help", "alpha"] },
    { command: "search-pack", args: ["--limit", "invalid", "--", "--version"] },
  ])("literal help text does not bypass malformed config: $command $args", ({ command, args }, { lib }) => {
    writeFileSync(lib.configPath, "{invalid");

    // An invalid limit prevents a failing implementation from opening the default library.
    const response = lib.run([command, "--format", "json", ...args]);

    expect(response.exitCode).toBe(1);
    expect(JSON.parse(response.stdout).error).toMatchObject({
      code: "UNKNOWN_ERROR",
      message: expect.stringContaining("JSON"),
    });
  });

  test("search keeps flag-like option values out of output settings", ({ lib }) => {
    const response = lib.run([
      "search", "--fts", "--docs-only", "--tag", "--verbose", "alpha", "--format", "json",
    ]);

    expect(response.exitCode).toBe(0);
    expect(JSON.parse(response.stdout)).toEqual({
      ok: true,
      command: "search",
      result: { retrievalMode: "fts", concepts: [], documents: [] },
    });
  });

  test("search omits echoed input by default and restores it in verbose mode", ({ lib }) => {
    const compact = lib.run(["search", "absent", "--fts", "--docs-only", "--format", "json"]);
    expect(compact.exitCode).toBe(0);
    expect(JSON.parse(compact.stdout).result).toEqual({
      retrievalMode: "fts",
      concepts: [],
      documents: [],
    });

    // Options before the query must not swallow it.
    const verbose = lib.run([
      "search", "--fts", "absent", "--docs-only", "--format", "json", "--verbose",
    ]);
    expect(verbose.exitCode).toBe(0);
    expect(JSON.parse(verbose.stdout).result).toMatchObject({
      query: "absent",
      retrievalMode: "fts",
      options: { ftsOnly: true },
      concepts: [],
      documents: [],
    });
  });

  test("search-pack preserves queries around options and after the option terminator", ({ lib }) => {
    const response = lib.run([
      "search-pack", "alpha", "--fts", "beta", "--limit=2", "--format", "json", "--", "--draft",
    ]);

    expect(response.exitCode).toBe(0);
    expect(JSON.parse(response.stdout).result.perQuery).toEqual([
      { query: "alpha", documents: [] },
      { query: "beta", documents: [] },
      { query: "--draft", documents: [] },
    ]);
  });

  test("search-pack omits echoed top-level input by default", ({ lib }) => {
    const compact = lib.run(["search-pack", "absent", "--fts", "--format", "json"]);
    expect(compact.exitCode).toBe(0);
    expect(JSON.parse(compact.stdout).result).toEqual({
      retrievalMode: "fts",
      perQuery: [{ query: "absent", documents: [] }],
      deduped: [],
    });

    const verbose = lib.run([
      "search-pack", "absent", "--fts", "--format", "json", "--verbose",
    ]);
    expect(verbose.exitCode).toBe(0);
    expect(JSON.parse(verbose.stdout).result).toMatchObject({
      queries: ["absent"],
      retrievalMode: "fts",
      options: { ftsOnly: true },
    });
  });

  test("semantic search reports provider failure instead of falling back to FTS", ({ lib }) => {
    const res = lib.run(["search", "absent", "--docs-only", "--format", "json", "--verbose"]);

    expect(res.exitCode).not.toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: false,
      command: "search",
      error: {
        code: "PROVIDER_NOT_READY",
        details: { provider: "ollama", requestedRetrievalMode: "hybrid" },
      },
    });
  });

  test("rechunk flag validation: --max-docs requires a numeric value", ({ lib }) => {
    const res = lib.run(["rechunk", "--max-docs", "--format", "json"]);

    expect(res.exitCode).not.toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS", message: expect.stringContaining("--max-docs") },
    });
  });

  test(
    "source integrity drives rechunk planning and deep doctor without exposing hashes",
    async ({ lib }) => {
      const sourcePath = join(lib.libraryPath, "source.md");
      const content = "# Source\n\noriginal\n";
      writeFileSync(sourcePath, content);
      await seedDocument(lib, {
        id: "doc-1",
        title: "Source",
        path: sourcePath,
        pageCount: 1,
        sizeBytes: Buffer.byteLength(content),
        fileType: "markdown",
        metadata: {
          chunker: {
            id: "markdown-extractor:shared-context-v4",
            version: 4,
            unit: "chars",
            chunkSize: 2000,
            chunkOverlap: 200,
          },
        },
      });
      const runJson = (argv: string[]) =>
        JSON.parse(lib.run([...argv, "--format", "json"]).stdout);

      const bulk = runJson(["rechunk", "--dry-run"]);
      expect(bulk.result.planned).toBe(0);
      expect(bulk.result.skippedMissing).toBe(1);

      const includeMissing = runJson(["rechunk", "--dry-run", "--include-missing"]);
      expect(includeMissing.result.planned).toBe(1);
      expect(includeMissing.result.docs[0].code).toBe("missing_identity");

      const explicitMissing = runJson(["rechunk", "--dry-run", "--doc", "doc-1"]);
      expect(explicitMissing.result.planned).toBe(1);

      const sourceHash = createHash("sha256").update(content).digest("hex");
      const db = openLibraryDb(lib.libraryPath);
      try {
        await db.execute({
          sql: `UPDATE documents
                SET source_hash_algorithm = 'sha256', source_hash = ?
                WHERE id = 'doc-1'`,
          args: [sourceHash],
        });
      } finally {
        db.close();
      }
      writeFileSync(sourcePath, "# Source\n\nchanged\n");

      const explicitChanged = runJson(["rechunk", "--dry-run", "--doc", "doc-1"]);
      expect(explicitChanged.result.docs[0].code).toBe("source_changed");
      expect(JSON.stringify(explicitChanged)).not.toContain(sourceHash);
      expect(JSON.stringify(explicitChanged)).not.toContain("sha256");

      const normalDoctor = runJson(["doctor"]);
      expect(normalDoctor.result.sourceIntegrity).toMatchObject({ checked: 0, changed: 0 });

      const deepDoctor = runJson(["doctor", "--deep"]);
      expect(deepDoctor.result.sourceIntegrity).toMatchObject({ checked: 1, changed: 1 });
      expect(deepDoctor.result.sourceIntegrity.sample[0]).toMatchObject({
        id: "doc-1",
        title: "Source",
        codes: ["source_changed"],
      });
      expect(JSON.stringify(deepDoctor)).not.toContain(sourceHash);
      expect(JSON.stringify(deepDoctor)).not.toContain("sha256");
      expect(JSON.stringify(deepDoctor)).not.toContain(sourcePath);
    },
    60_000,
  );

  describe("doc relocate", () => {
    const content = "# Source\n\noriginal\n";

    /** Seeds doc-1 stored at `<root>/old.md` and returns that path. */
    async function seedMarkdownDocument(lib: TestLibrary): Promise<string> {
      const oldPath = join(lib.root, "old.md");
      writeFileSync(oldPath, content);
      await seedDocument(lib, {
        id: "doc-1",
        title: "Source",
        path: oldPath,
        pageCount: 1,
        sizeBytes: Buffer.byteLength(content),
        fileType: "markdown",
      });
      return oldPath;
    }

    test.for([
      ["absolute", (path: string) => path],
      ["cwd-relative", (path: string) => relative(process.cwd(), path)],
    ] as const)(
      "updates only the stored document path given an %s target",
      async ([, toArgument], { lib }) => {
        const oldPath = await seedMarkdownDocument(lib);
        const newPath = join(lib.root, "relocated", "new.md");
        mkdirSync(join(lib.root, "relocated"));
        renameSync(oldPath, newPath);

        const res = lib.run([
          "doc", "relocate", "doc-1", toArgument(newPath), "--format", "json",
        ]);

        expect(res.exitCode).toBe(0);
        expect(JSON.parse(res.stdout)).toStrictEqual({
          ok: true,
          command: "doc relocate",
          result: { docId: "doc-1", title: "Source", oldPath, newPath, changed: true },
        });

        const readRes = lib.run(["read", "doc-1", "--format", "json"]);
        expect(readRes.exitCode).toBe(0);
        expect(JSON.parse(readRes.stdout).result).toMatchObject({
          title: "Source",
          path: newPath,
          pageCount: 1,
          tags: [],
          fileType: "markdown",
        });
      },
    );

    test("dry-run reports metadata without updating the database", async ({ lib }) => {
      const oldPath = await seedMarkdownDocument(lib);
      const newPath = join(lib.root, "new.md");
      writeFileSync(newPath, "# Source\n\nmodified\n");

      const res = lib.run([
        "doc", "relocate", "doc-1", newPath, "--dry-run", "--format", "json",
      ]);

      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toStrictEqual({
        ok: true,
        command: "doc relocate",
        result: {
          docId: "doc-1",
          title: "Source",
          oldPath,
          newPath,
          changed: false,
          dryRun: true,
        },
      });

      const readRes = lib.run(["read", "doc-1", "--format", "json"]);
      expect(readRes.exitCode).toBe(0);
      expect(JSON.parse(readRes.stdout).result.path).toBe(oldPath);
    });

    test("rejects missing target paths", ({ lib }) => {
      const missingPath = join(lib.root, "missing.md");

      const res = lib.run(["doc", "relocate", "doc-1", missingPath, "--format", "json"]);

      expect(res.exitCode).not.toBe(0);
      expect(JSON.parse(res.stdout)).toMatchObject({
        ok: false,
        command: "doc",
        error: {
          code: "NEW_PATH_NOT_FOUND",
          message: expect.stringContaining(missingPath),
        },
      });
    });
  });

  test("capabilities is self-describing without embedding JSON Schemas", ({ lib }) => {
    const res = lib.run(["capabilities", "--format", "json"]);

    expect(res.exitCode).toBe(0);
    const obj = JSON.parse(res.stdout);
    expect(obj).toMatchObject({ ok: true, command: "capabilities" });
    const result = obj.result;
    expect(Object.keys(result).sort()).toEqual([
      "commands",
      "globalFlags",
      "outputFormats",
      "poinkVersion",
    ]);
    expect(typeof result.poinkVersion).toBe("string");
    expect(result.outputFormats).toEqual(["text", "json", "ndjson"]);
    expect(result.globalFlags["--config"]).toMatchObject({
      type: "path",
      placement: "after-command",
    });
    expect(result.globalFlags["--verbose"]).toBeDefined();

    // Agent discovery depends on these names; the interactive setup wizard stays hidden.
    const commands: { name: string; argv: string[] }[] = result.commands;
    const names = commands.map((command) => command.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "search", "search-pack", "chunk", "doc", "doc relocate", "page", "add",
        "stats", "rechunk", "reindex", "mcp", "serve", "providers",
      ]),
    );
    expect(names).not.toContain("setup");
    expect(commands.find((command) => command.name === "providers")?.argv).toEqual([
      "providers", "login", "--provider", "openai-codex", "--format", "text", "[--device-auth]",
    ]);
  });

  test("config schema exposes the config schema outside capabilities", ({ lib }) => {
    const fetched = lib.run(["config", "schema", "--format", "json"]);

    expect(fetched.exitCode).toBe(0);
    expect(JSON.parse(fetched.stdout).result).toMatchObject({
      type: "object",
      properties: {
        models: expect.any(Object),
        providers: expect.any(Object),
        storage: { properties: { libsql: expect.any(Object) } },
      },
    });
  });

  test("taxonomy list is compact and taxonomy get returns details", async ({ lib }) => {
    expect(lib.run(["stats"]).exitCode).toBe(0);
    const db = openLibraryDb(lib.libraryPath);
    const insertConcept = `INSERT INTO concepts
                             (id, pref_label, alt_labels, definition, created_at)
                           VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`;
    try {
      await db.batch(
        [
          {
            sql: insertConcept,
            args: ["programming", "Programming", "[]", "Software development and programming topics"],
          },
          {
            sql: insertConcept,
            args: ["programming/typescript", "TypeScript", "[\"TS\"]", "TypeScript language and ecosystem"],
          },
          {
            sql: "INSERT INTO concept_hierarchy (concept_id, broader_id) VALUES (?, ?)",
            args: ["programming/typescript", "programming"],
          },
        ],
        "write",
      );
    } finally {
      db.close();
    }

    const listed = lib.run(["taxonomy", "list", "--format", "json"]);
    expect(listed.exitCode).toBe(0);
    const concepts = JSON.parse(listed.stdout).result.concepts;
    expect(concepts).toContainEqual({ id: "programming", prefLabel: "Programming" });
    expect(concepts[0]).not.toHaveProperty("definition");
    expect(concepts[0]).not.toHaveProperty("createdAt");

    const verboseList = lib.run(["taxonomy", "list", "--format", "json", "--verbose"]);
    expect(verboseList.exitCode).toBe(0);
    const verboseConcepts = JSON.parse(verboseList.stdout).result.concepts;
    expect(verboseConcepts[0]).toHaveProperty("altLabels");
    expect(verboseConcepts[0]).not.toHaveProperty("createdAt");

    const fetched = lib.run(["taxonomy", "get", "programming/typescript", "--format", "json"]);
    expect(fetched.exitCode).toBe(0);
    const detail = JSON.parse(fetched.stdout).result;
    expect(detail).toMatchObject({
      id: "programming/typescript",
      definition: "TypeScript language and ecosystem",
      broader: [{ id: "programming", prefLabel: "Programming" }],
      narrower: [],
      related: [],
    });
    expect(detail).not.toHaveProperty("createdAt");

    const treeRes = lib.run(["taxonomy", "tree", "--format", "json"]);
    expect(treeRes.exitCode).toBe(0);
    const tree = JSON.parse(treeRes.stdout).result.tree;
    expect(tree[0]).not.toHaveProperty("concept");
    expect(tree).toContainEqual(
      expect.objectContaining({
        id: "programming",
        children: expect.arrayContaining([
          expect.objectContaining({ id: "programming/typescript", prefLabel: "TypeScript" }),
        ]),
      }),
    );
  });

  test("setup lists available subcommands without running the wizard", ({ lib }) => {
    const res = lib.run(["setup", "--format", "text"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Usage: poink setup <command>");
    expect(res.stdout).toContain("Initialize Poink and run the configuration wizard");
    expect(res.stdout).toContain("Run the configuration wizard for an initialized library");
  });

  test("setup interactive commands require text format, including dry-run", ({ lib }) => {
    for (const argv of [
      ["setup", "init"],
      ["setup", "config"],
      ["setup", "init", "--dry-run"],
      ["setup", "config", "--dry-run"],
    ]) {
      const res = lib.run([...argv, "--format", "json"]);

      expect(res.exitCode).not.toBe(0);
      expect(JSON.parse(res.stdout)).toMatchObject({
        ok: false,
        command: "setup",
        error: { code: "INVALID_ARGS", message: expect.stringContaining("--format text") },
      });
    }
  });

  test("setup config fails before prompting when library is not initialized", ({ tmp }) => {
    const lib = setupLibrary(tmp, { librarySubdir: "missing-library" });

    const res = lib.run(["setup", "config", "--format", "text"]);

    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("NOT_INITIALIZED");
    expect(res.stderr).toContain("poink setup init");
  });

  test("providers login requires text format because it is interactive", ({ lib }) => {
    const res = lib.run([
      "providers", "login", "--provider", "openai-codex", "--format", "json", "--verbose",
    ]);

    expect(res.exitCode).not.toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: false,
      command: "providers",
      error: {
        code: "INVALID_ARGS",
        message: expect.stringContaining("--format text"),
        details: { hint: "poink providers login --provider openai-codex --format text" },
      },
    });
  });

  test("providers login rejects unsupported provider login flags", ({ lib }) => {
    const res = lib.run([
      "providers", "login", "--provider", "openai-codex", "--device-code",
      "--format", "json", "--verbose",
    ]);

    expect(res.exitCode).not.toBe(0);
    const obj = JSON.parse(res.stdout);
    expect(obj).toMatchObject({
      ok: false,
      command: "providers",
      error: { code: "INVALID_ARGS", message: expect.stringContaining("--device-code") },
    });
    expect(obj.error.details.available).toContain("--device-auth");
  });

  test("service-free command help does not require runtime services", ({ lib }) => {
    for (const command of ["config", "providers", "setup"]) {
      const res = lib.run([command, "--help", "--format", "json"]);

      expect(res.exitCode).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj).toMatchObject({ ok: true, command: "help" });
      expect(obj.result.help).toContain(
        "poink providers login --provider openai-codex --format text",
      );
      expect(obj.result.help).toContain("poink setup init --format text");
    }
  });

  test("config show text output works before the library exists and includes libSQL details", ({ tmp }) => {
    const lib = setupLibrary(tmp, { librarySubdir: "missing-library" });

    const res = lib.run(["config", "show", "--format", "text"]);

    expect(res.exitCode).toBe(0);
    for (const text of ["PDF Library Config", "Storage:", "libSQL", "Database:", "OpenAI Codex:"]) {
      expect(res.stdout).toContain(text);
    }
  });

  describe("stored secrets", () => {
    const secrets = {
      openrouterApiKey: "openrouter-secret",
      libsqlAuthToken: "libsql-secret",
      serverToken: "server-secret",
    };

    test("config show redacts stored secrets unless --show-secrets is passed", ({ tmp }) => {
      const lib = setupLibrary(tmp, { secrets });

      const redacted = lib.run(["config", "show", "--format", "json"]);
      expect(redacted.exitCode).toBe(0);
      for (const secret of Object.values(secrets)) {
        expect(redacted.stdout).not.toContain(secret);
      }
      const config = JSON.parse(redacted.stdout).result.config;
      expect(config.providers.openrouter).toMatchObject({
        apiKey: "[redacted]",
        apiKeyEnv: "OPENROUTER_API_KEY",
      });
      expect(config.storage.libsql.authToken).toBe("[redacted]");
      expect(config.server.auth).toMatchObject({
        token: "[redacted]",
        tokenEnv: "POINK_SERVER_TOKEN",
      });

      const raw = lib.run(["config", "show", "--show-secrets", "--format", "json"]);
      expect(raw.exitCode).toBe(0);
      const rawConfig = JSON.parse(raw.stdout).result.config;
      expect(rawConfig.providers.openrouter.apiKey).toBe("openrouter-secret");
      expect(rawConfig.server.auth.token).toBe("server-secret");
    });

    test("config get redacts secrets at and below the requested path unless --show-secrets is passed", ({ tmp }) => {
      const lib = setupLibrary(tmp, { secrets });
      const getRedacted = (path: string) => {
        const res = lib.run(["config", "get", path, "--format", "json"]);
        expect(res.exitCode).toBe(0);
        for (const secret of Object.values(secrets)) {
          expect(res.stdout).not.toContain(secret);
        }
        return JSON.parse(res.stdout).result.value;
      };

      expect(getRedacted("providers.openrouter.apiKey")).toBe("[redacted]");
      expect(getRedacted("providers.openrouter").apiKey).toBe("[redacted]");
      expect(getRedacted("server.auth").token).toBe("[redacted]");

      const raw = lib.run([
        "config", "get", "providers.openrouter.apiKey", "--show-secrets", "--format", "json",
      ]);
      expect(raw.exitCode).toBe(0);
      expect(JSON.parse(raw.stdout).result.value).toBe("openrouter-secret");
    });

    // The openrouter config starts without a key, so the set must not require a valid current config.
    test("config set redacts stored secrets in output but persists raw values", ({ tmp }) => {
      const lib = setupLibrary(tmp, { modelProvider: "openrouter" });
      const apiKeyPath = "providers.openrouter.apiKey";

      const redacted = lib.run(["config", "set", apiKeyPath, "test-openrouter-key", "--format", "json"]);
      expect(redacted.exitCode).toBe(0);
      expect(redacted.stdout).not.toContain("test-openrouter-key");
      expect(JSON.parse(redacted.stdout)).toMatchObject({
        ok: true,
        command: "config",
        result: { path: apiKeyPath, value: "[redacted]" },
      });
      expect(valueAtPath(readSavedConfig(lib), apiKeyPath)).toBe("test-openrouter-key");

      const raw = lib.run([
        "config", "set", apiKeyPath, "replacement-openrouter-key", "--show-secrets", "--format", "json",
      ]);
      expect(raw.exitCode).toBe(0);
      expect(JSON.parse(raw.stdout).result.value).toBe("replacement-openrouter-key");
      expect(valueAtPath(readSavedConfig(lib), apiKeyPath)).toBe("replacement-openrouter-key");
    });
  });

  test.for([
    ["models.enrichment.reasoning", "xhigh", "xhigh"],
    ["models.judge.reasoning", "null", null],
    ["cli.globalFlags.format", "json", "json"],
    ["ingest.urlDownloads.maxFileSize", "250mb", "250mb"],
    ["ingest.urlDownloads.allowedPrivateNetworkHosts", "docs.internal,repo.internal", ["docs.internal", "repo.internal"]],
    ["ingest.include", "docs/**/*.md,papers/**/*.pdf", ["docs/**/*.md", "papers/**/*.pdf"]],
    ["ingest.exclude", "docs/archive/**,papers/drafts/**", ["docs/archive/**", "papers/drafts/**"]],
    ["ingest.visuals.maxImageBytes", "10mb", "10mb"],
  ] as const)("config set %s %s parses and persists the value", ([path, input, expected], { lib }) => {
    const res = lib.run(["config", "set", path, input, "--format", "json"]);

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: true,
      command: "config",
      result: { path, value: expected },
    });
    expect(valueAtPath(readSavedConfig(lib), path)).toEqual(expected);
  });

  test("config set fills defaults for a newly created config section", ({ lib }) => {
    const res = lib.run(["config", "set", "ingest.visuals.enabled", "true", "--format", "json"]);

    expect(res.exitCode).toBe(0);
    expect(valueAtPath(readSavedConfig(lib), "ingest.visuals")).toMatchObject({
      enabled: true,
      maxImagesPerDocument: 100,
    });
  });

  test.for([
    ["ingest.urlDownloads.maxFileSize", "100"],
    ["cli.globalFlags.format", "xml"],
    ["models.enrichment.reasoning", "max"],
    ["providers.openrouter.apiKeyyyyy", "123"],
    ["chunking.overlap", "2000"],
  ] as const)("config set rejects %s=%s without touching the config file", ([path, input], { lib }) => {
    const before = readFileSync(lib.configPath, "utf-8");

    const res = lib.run(["config", "set", path, input, "--format", "json"]);

    expect(res.exitCode).not.toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS", message: expect.stringContaining(path) },
    });
    expect(readFileSync(lib.configPath, "utf-8")).toBe(before);
  });

  test("init creates a missing library directory before opening the database", ({ tmp }) => {
    const lib = setupLibrary(tmp, { librarySubdir: "missing-library", modelProvider: "openrouter" });

    const res = lib.run(["init", "--format", "json"]);

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      ok: true,
      command: "init",
      result: {
        libraryPath: lib.libraryPath,
        dbPath: join(lib.libraryPath, "library.db"),
      },
    });
  });

  describe("ingest file selection", () => {
    test("--no-recursive with filters does not scan nested directories", ({ lib }) => {
      const docs = join(lib.root, "docs");
      mkdirSync(join(docs, "nested"), { recursive: true });
      writeFileSync(join(docs, "nested", "note.md"), "# Nested note\n\nNot discovered.", "utf-8");

      const res = lib.run([
        "ingest", docs, "--include", "**/*.md", "--exclude", "**/archive/**",
        "--no-recursive", "--format", "json",
      ]);

      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toMatchObject({
        ok: true,
        command: "ingest",
        result: { foundFiles: 0 },
      });
      expect(JSON.parse(res.stdout).result.selection).toEqual({
        include: ["**/*.md"],
        exclude: ["**/archive/**"],
        discovered: 0,
        included: 0,
        excluded: 0,
        selected: 0,
        sampled: 0,
      });
    });

    test("include globs filter selected files in JSON output", ({ lib }) => {
      const docs = join(lib.root, "docs");
      mkdirSync(docs);
      writeFileSync(join(docs, "paper.pdf"), "%PDF-1.7", "utf-8");

      const res = lib.run(["ingest", docs, "--include", "**/*.md", "--format", "json"]);

      expect(res.exitCode).toBe(0);
      const result = JSON.parse(res.stdout).result;
      expect(result.foundFiles).toBe(0);
      expect(result.selection).toEqual({
        include: ["**/*.md"],
        exclude: [],
        discovered: 1,
        included: 0,
        excluded: 0,
        selected: 0,
        sampled: 0,
      });
    });

    test("explains cwd-relative filters rejecting an external directory", ({ lib }) => {
      const projectRoot = join(lib.root, "project");
      const docs = join(lib.root, "external-docs");
      mkdirSync(projectRoot);
      mkdirSync(docs);
      writeFileSync(join(docs, "paper.pdf"), "%PDF-1.7", "utf-8");

      const res = lib.run(["ingest", docs, "--include", "**/*.pdf"], { cwd: projectRoot });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("No files matched the include filters");
      expect(res.stdout).toContain(
        `Filter paths are relative to the working directory: ${projectRoot}`,
      );
      expect(res.stdout).not.toContain("No supported document files found");
    });

    test("uses config include and exclude when CLI filters are absent", ({ tmp }) => {
      const lib = setupLibrary(tmp, { ingest: { include: ["**/*.md"], exclude: ["**/*.md"] } });
      const docs = join(lib.root, "docs");
      mkdirSync(docs);
      writeFileSync(join(docs, "note.md"), "# Note", "utf-8");

      const res = lib.run(["ingest", ".", "--format", "json"], { cwd: docs });

      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).result.selection).toEqual({
        include: ["**/*.md"],
        exclude: ["**/*.md"],
        discovered: 1,
        included: 1,
        excluded: 1,
        selected: 0,
        sampled: 0,
      });
    });

    test("matches configured filters relative to the working directory", ({ tmp }) => {
      const pattern = "companies/*/sources/**/*";
      const lib = setupLibrary(tmp, { ingest: { include: [pattern], exclude: [pattern] } });
      const projectRoot = join(lib.root, "project");
      const reportDirectories = [
        "companies/kruk/sources/2026/2026-h1/reports",
        "companies/synektik/sources/2025/2025-q3/reports",
        "companies/xtb/sources/2026/2026-h1/reports",
      ];
      for (const [index, reportDirectory] of reportDirectories.entries()) {
        const absoluteDirectory = join(projectRoot, reportDirectory);
        mkdirSync(absoluteDirectory, { recursive: true });
        writeFileSync(join(absoluteDirectory, `report-${index + 1}.md`), `# Report ${index + 1}`, "utf-8");
      }

      const res = lib.run(["ingest", ...reportDirectories, "--format", "json"], { cwd: projectRoot });

      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).result.selection).toEqual({
        include: [pattern],
        exclude: [pattern],
        discovered: 3,
        included: 3,
        excluded: 3,
        selected: 0,
        sampled: 0,
      });
    });

    test("CLI include overrides config include and CLI exclude extends config exclude", ({ tmp }) => {
      const lib = setupLibrary(tmp, { ingest: { include: ["**/*.pdf"], exclude: ["archive/**"] } });
      const docs = join(lib.root, "docs");
      mkdirSync(join(docs, "drafts"), { recursive: true });
      writeFileSync(join(docs, "paper.pdf"), "%PDF-1.7", "utf-8");
      writeFileSync(join(docs, "drafts", "note.md"), "# Draft", "utf-8");

      const res = lib.run(
        ["ingest", ".", "--include", "**/*.md", "--exclude", "drafts/**", "--format", "json"],
        { cwd: docs },
      );

      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).result.selection).toEqual({
        include: ["**/*.md"],
        exclude: ["archive/**", "drafts/**"],
        discovered: 2,
        included: 1,
        excluded: 1,
        selected: 0,
        sampled: 0,
      });
    });

    test("excludes win over includes and text prints selection counters", ({ lib }) => {
      const docs = join(lib.root, "docs");
      mkdirSync(join(docs, "archive"), { recursive: true });
      writeFileSync(join(docs, "archive", "note.md"), "# Archived", "utf-8");

      const res = lib.run(
        ["ingest", ".", "--include", "**/*.md", "--exclude", "**/archive/**"],
        { cwd: docs },
      );

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("Selection: discovered 1, included 1, excluded 1, selected 0");
      expect(res.stdout).toContain("Include:\n  **/*.md");
      expect(res.stdout).toContain("Exclude:\n  **/archive/**");
    });
  });
});

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

/** Runs `fn` against a stdio `poink mcp` child process; its stderr is piped and discarded. */
async function withMcpClient<T>(
  lib: TestLibrary,
  args: string[],
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: nodeTsxArgs(["mcp", ...args]),
    cwd: process.cwd(),
    stderr: "pipe",
    env: childEnv(lib.env),
  });
  const client = new Client({ name: "poink-contract-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

describe("MCP Tool Output Contract", () => {
  test(
    "mcp tools return structuredContent matching the agent envelope schema",
    ({ lib }) =>
      withMcpClient(lib, [], async (client) => {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["capabilities", "config_schema", "stats", "search", "taxonomy_get"]),
        );

        const stats = await client.callTool({ name: "stats", arguments: {} });
        expect(Boolean(stats.isError)).toBe(false);
        expect(stats.structuredContent).toStrictEqual({
          ok: true,
          command: "stats",
          result: expect.objectContaining({ libraryPath: lib.libraryPath }),
        });
        const textContent = (Array.isArray(stats.content) ? stats.content : []).find(isTextContent);
        if (!textContent) throw new Error("Expected text tool content");
        expect(JSON.parse(textContent.text)).toEqual(stats.structuredContent);

        const ftsSearch = await client.callTool({
          name: "search",
          arguments: { query: "absent", docsOnly: true, fts: true },
        });
        expect(ftsSearch.structuredContent).toMatchObject({
          ok: true,
          result: { retrievalMode: "fts", documents: [] },
        });

        // Flag-like queries stay queries, and the output matches the CLI byte for byte.
        const queries = ["alpha", "--help", "--format", "text", "--verbose", "--config"];
        const pack = await client.callTool({
          name: "search_pack",
          arguments: { queries, fts: true, limit: 2, withContent: true, globalLimit: 3 },
        });
        expect(pack.structuredContent).toMatchObject({
          ok: true,
          command: "search-pack",
          result: {
            retrievalMode: "fts",
            perQuery: queries.map((query) => ({ query, documents: [] })),
            deduped: [],
          },
        });
        const cliPack = lib.run([
          "search-pack", "--fts", "--limit", "2", "--with-content",
          "--global-limit", "3", "--format", "json", "--", ...queries,
        ]);
        expect(cliPack.exitCode).toBe(0);
        expect(JSON.parse(cliPack.stdout)).toEqual(pack.structuredContent);

        const semanticSearch = await client.callTool({
          name: "search",
          arguments: { query: "absent", docsOnly: true },
        });
        expect(semanticSearch.isError).toBe(true);
        expect(semanticSearch.structuredContent).toMatchObject({
          ok: false,
          error: { code: "PROVIDER_NOT_READY" },
        });
      }),
    20_000,
  );

  test(
    "verbose MCP results and errors include timing metadata",
    ({ lib }) =>
      withMcpClient(lib, ["--verbose"], async (client) => {
        const callEnvelope = async (name: string, args: Record<string, unknown>) => {
          const { structuredContent } = await client.callTool({ name, arguments: args });
          if (!isRecord(structuredContent)) throw new Error(`Expected ${name} envelope`);
          return structuredContent;
        };

        const success = await callEnvelope("stats", {});
        expect(success.ok).toBe(true);
        expect(Object.keys(success).sort()).toEqual(["command", "meta", "nextActions", "ok", "result"]);
        expectTimingMetadata(success.meta, { command: true });

        const failure = await callEnvelope("read", { idOrTitle: "missing-document" });
        expect(failure.ok).toBe(false);
        expect(Object.keys(failure).sort()).toEqual(["command", "error", "meta", "ok"]);
        expectTimingMetadata(failure.meta, { command: true });
      }),
    20_000,
  );
});

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

/**
 * Starts `poink serve` on a free port, waits for /health to answer, and passes its port and
 * health body to `fn`. The server is killed afterwards.
 */
async function withServer(
  lib: TestLibrary,
  options: { host: string; env?: Record<string, string> },
  fn: (port: number, health: unknown) => Promise<void>,
): Promise<void> {
  const port = await getAvailablePort();
  const proc = spawn(
    process.execPath,
    nodeTsxArgs(["serve", "--host", options.host, "--port", String(port)]),
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv({ ...lib.env, ...options.env }),
    },
  );
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));

  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
      if (health?.ok) {
        await fn(port, await health.json());
        return;
      }
      await sleep(100);
    }
    throw new Error("serve did not become healthy");
  } finally {
    proc.kill();
    await exited;
  }
}

describe("HTTP MCP Server", () => {
  const withoutServerToken = { POINK_SERVER_TOKEN: undefined };

  test("serve refuses non-loopback binds without bearer auth", async ({ lib }) => {
    const port = await getAvailablePort();

    const res = lib.run(["serve", "--host", "0.0.0.0", "--port", String(port)], {
      env: withoutServerToken,
    });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Refusing to bind HTTP MCP server");
  });

  test("verbose serve startup failures include total timing only", async ({ lib }) => {
    const port = await getAvailablePort();

    const res = lib.run(
      ["serve", "--host", "0.0.0.0", "--port", String(port), "--format", "json", "--verbose"],
      { env: withoutServerToken },
    );

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("");
    const obj = JSON.parse(res.stdout);
    expect(obj).toMatchObject({
      ok: false,
      command: "serve",
      error: {
        code: "INVALID_CONFIG",
        message: expect.stringContaining("Refusing to bind HTTP MCP server"),
      },
    });
    expectTimingMetadata(obj.meta, { command: false });
  });

  test("serve starts the HTTP MCP server and exposes /health", ({ lib }) =>
    withServer(lib, { host: "127.0.0.1" }, async (port, health) => {
      expect(health).toEqual({
        ok: true,
        host: "127.0.0.1",
        port,
        auth: { enabled: false },
      });
    }));

  test("serve enables bearer auth for non-loopback binds with env token", ({ lib }) =>
    withServer(
      lib,
      { host: "0.0.0.0", env: { POINK_SERVER_TOKEN: "env-token" } },
      async (port, health) => {
        expect(health).toEqual({
          ok: true,
          host: "0.0.0.0",
          port,
          auth: { enabled: true },
        });
        const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`);
        expect(unauthorized.status).toBe(401);
      },
    ));
});
