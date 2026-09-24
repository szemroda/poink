import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessWALHealth } from "./cli/health.js";
import {
  getCheckpointInterval,
  shouldCheckpoint,
  parseArgs,
} from "./cli/args.js";
import { selectDefaultModel } from "./cli/commands/setup.js";
import {
  filenameFromURL,
  getDownloadTargetPath,
  looksLikeMarkdown,
  hasMarkdownExtension,
  parseSizeString,
  parseDurationString,
  isPrivateNetworkAddress,
  assertURLDownloadAllowed,
  downloadFile,
  readResponseBufferWithLimit,
  resolveURLDownloadOptions,
} from "./urlDownloads.js";
import { Config, type DocumentFileType } from "./types.js";

function eventually<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeout),
  );
}

/**
 * Serves `handler` on loopback and downloads `path` from it into a temp
 * directory, resolving to the saved file path.
 */
async function downloadFromTestServer(
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const downloadsDir = mkdtempSync(join(tmpdir(), "poink-url-downloads-"));
  try {
    const { port } = server.address() as AddressInfo;
    const options = resolveURLDownloadOptions(Config.Default, {
      "allow-private-network": true,
      "download-timeout": "5s",
    });
    return await eventually(
      Effect.runPromise(
        downloadFile(
          `http://127.0.0.1:${port}${path}`,
          downloadsDir,
          options,
          "poink-test",
        ),
      ),
      1_000,
    );
  } finally {
    rmSync(downloadsDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("setup defaults", () => {
  test.each([
    ["embedding", "openai", "custom-embedding-model", "openai", "custom-embedding-model"],
    ["embedding", "ollama", "mxbai-embed-large", "google", "gemini-embedding-2"],
    ["language", "ollama", "llama3.2:3b", "openrouter", "openai/gpt-5.4-mini"],
  ] as const)(
    "%s model on %s (%s) switched to %s defaults to %s",
    (kind, currentProvider, currentModel, selectedProvider, expected) => {
      expect(
        selectDefaultModel({
          kind,
          currentProvider,
          currentModel,
          selectedProvider,
        }),
      ).toBe(expected);
    },
  );
});

describe("filenameFromURL", () => {
  test.each([
    ["https://example.com/paper.pdf", "paper.pdf"],
    ["https://example.com/README.md", "README.md"],
    ["https://example.com/doc.markdown", "doc.markdown"],
    ["https://example.com/notes.txt", "notes.txt"],
    ["https://example.com/brief.docx", "brief.docx"],
    ["https://example.com/notes.odt", "notes.odt"],
    ["https://example.com/flat.fodt", "flat.fodt"],
    ["https://example.com/doc.pdf?token=abc", "doc.pdf"],
    ["https://example.com/document", "document.pdf"],
    // ".md" elsewhere in the path must not count as an extension.
    ["https://example.com/markdown-docs/file", "file.pdf"],
    ["https://example.com/docs.md.backup/file", "file.pdf"],
  ])("%s -> %s", (url, expected) => {
    expect(filenameFromURL(url)).toBe(expected);
  });
});

describe("getDownloadTargetPath", () => {
  const downloadsDir = join("tmp", "downloads");

  test.each<[string, DocumentFileType, string]>([
    ["https://example.com/paper.pdf", "pdf", "paper.pdf"],
    ["https://example.com/paper.pdf", "markdown", "paper.md"],
    ["https://example.com/docs/readme", "markdown", "readme.md"],
    ["https://example.com/guide.markdown", "markdown", "guide.markdown"],
    ["https://example.com/notes", "txt", "notes.txt"],
    ["https://example.com/notes.txt", "txt", "notes.txt"],
    ["https://example.com/report.docx", "docx", "report.docx"],
    ["https://example.com/notes.odt", "odt", "notes.odt"],
    ["https://example.com/flat.fodt", "odt", "flat.fodt"],
  ])("%s detected as %s -> %s", (url, fileType, filename) => {
    expect(getDownloadTargetPath(url, downloadsDir, fileType)).toBe(
      join(downloadsDir, filename),
    );
  });
});

describe("hasMarkdownExtension", () => {
  test.each([
    ["https://example.com/file.md", true],
    ["https://example.com/file.markdown", true],
    ["https://example.com/file.MD", true],
    ["https://example.com/file.MARKDOWN", true],
    ["https://example.com/file.pdf", false],
    ["https://example.com/file.txt", false],
    ["https://example.com/file", false],
    ["https://example.com/markdown-docs/file", false],
    ["https://example.com/docs.md.backup/file.txt", false],
  ])("%s -> %s", (url, expected) => {
    expect(hasMarkdownExtension(url)).toBe(expected);
  });
});

describe("looksLikeMarkdown", () => {
  test.each([
    "# Hello World",
    "## Section",
    "###### Deepest",
    "- item one\n- item two",
    "* item one\n* item two",
    "+ item one\n+ item two",
    "1. First\n2. Second",
    "```javascript\nconst x = 1;\n```",
    "| Col1 | Col2 |\n|------|------|",
    "Check out [this link](https://example.com)",
    "Some intro text\n\n## Section Header\n\nThis is a paragraph.\n",
  ])("detects markdown in %j", (content) => {
    expect(looksLikeMarkdown(content)).toBe(true);
  });

  test.each([
    "This is just plain text without any markers.",
    "This has a # in the middle",
    "This has a - in the middle",
    "",
    "   \n\n   ",
  ])("treats %j as plain text", (content) => {
    expect(looksLikeMarkdown(content)).toBe(false);
  });
});

describe("secure URL download options", () => {
  test("parses size strings with required unit suffixes", () => {
    expect(parseSizeString("500kb")).toBe(500 * 1024);
    expect(parseSizeString("100mb")).toBe(100 * 1024 * 1024);
    expect(parseSizeString("1.5gb")).toBe(Math.floor(1.5 * 1024 * 1024 * 1024));
    expect(() => parseSizeString("100")).toThrow(/unit suffix/);
  });

  test("parses duration strings with required unit suffixes", () => {
    expect(parseDurationString("500ms")).toBe(500);
    expect(parseDurationString("30s")).toBe(30_000);
    expect(parseDurationString("2m")).toBe(120_000);
    expect(() => parseDurationString("30")).toThrow(/unit suffix/);
  });

  test.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["169.254.169.254", true],
    ["::1", true],
    ["fc00::1", true],
    ["8.8.8.8", false],
    // IPv4-mapped IPv6, in dotted and hex forms.
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::ffff:10.1.2.3", true],
    ["::ffff:a01:203", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:a9fe:a9fe", true],
    ["::ffff:8.8.8.8", false],
    ["::ffff:808:808", false],
  ])("isPrivateNetworkAddress(%s) is %s", (address, expected) => {
    expect(isPrivateNetworkAddress(address)).toBe(expected);
  });

  test.each([
    ["10.0.0.5", 4],
    ["::ffff:7f00:1", 6],
  ])(
    "blocks DNS targets that resolve to private address %s by default",
    async (address, family) => {
      const options = resolveURLDownloadOptions(Config.Default, {});

      await expect(
        assertURLDownloadAllowed(
          new URL("https://docs.example.test/file.pdf"),
          options,
          async () => [{ address, family }],
        ),
      ).rejects.toThrow(/Blocked private/);
    },
  );

  test("allows configured private-network host exceptions", async () => {
    const options = resolveURLDownloadOptions(Config.Default, {
      "allowed-private-network-hosts": "docs.internal.test",
    });

    await expect(
      assertURLDownloadAllowed(
        new URL("https://docs.internal.test/file.pdf"),
        options,
        async () => [{ address: "10.0.0.5", family: 4 }],
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects responses whose content-length exceeds the cap", async () => {
    const response = new Response("ok", {
      headers: { "content-length": "1024" },
    });

    await expect(readResponseBufferWithLimit(response, 10)).rejects.toThrow(
      /max file size/,
    );
  });

  test("rejects streamed responses that exceed the cap without content-length", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4, 5]));

    await expect(readResponseBufferWithLimit(response, 4)).rejects.toThrow(
      /max file size/,
    );
  });

  test("closes non-success URL download responses without reading the body", async () => {
    let markClosed!: () => void;
    const responseClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });

    await expect(
      downloadFromTestServer("/error.pdf", (_req, res) => {
        res.on("close", markClosed);
        res.writeHead(500, { "content-type": "application/pdf" });
        res.write(Buffer.alloc(1024));
      }),
    ).rejects.toThrow(/HTTP 500/);
    await expect(eventually(responseClosed, 1_000)).resolves.toBeUndefined();
  });

  test.each([
    // Unsupported metadata only yields a provisional PDF filename.
    ["/index.html", "text/html", "<!doctype html>", "index.html.pdf"],
    ["/notes", "text/plain; charset=utf-8", "Plain text note.", "notes.txt"],
    // Textual MIME types override a misleading .pdf URL suffix.
    ["/readme.pdf", "text/markdown", "plain words", "readme.md"],
    ["/readme.pdf", "text/plain", "# Heading", "readme.md"],
    ["/readme.pdf", "text/plain", "plain words", "readme.txt"],
  ])(
    "saves %s served as %s with body %j as %s",
    async (path, contentType, body, filename) => {
      const saved = await downloadFromTestServer(path, (_req, res) => {
        res.writeHead(200, { "content-type": contentType });
        res.end(body);
      });

      expect(saved.endsWith(filename)).toBe(true);
    },
  );
});

describe("WAL health assessment", () => {
  const MB = 1024 * 1024;

  test.each([
    [{ fileCount: 50, totalSizeBytes: 50 * MB }, []],
    [
      { fileCount: 60, totalSizeBytes: MB },
      ["WAL file count (60) exceeds recommended threshold (50)"],
    ],
    [
      { fileCount: 10, totalSizeBytes: 60 * MB },
      ["WAL size (60.0 MB) exceeds recommended threshold (50 MB)"],
    ],
    [
      { fileCount: 100, totalSizeBytes: 100 * MB },
      [
        "WAL file count (100) exceeds recommended threshold (50)",
        "WAL size (100.0 MB) exceeds recommended threshold (50 MB)",
      ],
    ],
  ])("%j -> %j", (stats, warnings) => {
    expect(assessWALHealth(stats)).toEqual({
      healthy: warnings.length === 0,
      warnings,
    });
  });
});

describe("automatic checkpoint during batch operations", () => {
  test.each([
    [{}, 50],
    [{ "checkpoint-interval": "25" }, 25],
    [{ "checkpoint-interval": "0" }, 50],
    [{ "checkpoint-interval": "abc" }, 50],
  ])("getCheckpointInterval(%j) is %i", (opts, expected) => {
    expect(getCheckpointInterval(opts)).toBe(expected);
  });

  test("checkpoints only at positive multiples of the interval", () => {
    const processed = [0, 1, 49, 50, 51, 99, 100, 150];

    expect(processed.filter((count) => shouldCheckpoint(count, 50))).toEqual([
      50, 100, 150,
    ]);
  });
});

describe("parseArgs", () => {
  test.each([
    [["--include-clusters", "--limit", "5"], { "include-clusters": true, limit: "5" }],
    [["query", "--limit", "10"], { limit: "10" }],
    [
      ["--enrich", "--visuals", "--auto-tag"],
      { enrich: true, visuals: true, "auto-tag": true },
    ],
    [["--no-enrich", "--max-docs=3"], { enrich: false, "max-docs": "3" }],
    [["paper.pdf"], {}],
  ])("%j -> %j", (args, expected) => {
    expect(parseArgs(args)).toEqual(expected);
  });
});
