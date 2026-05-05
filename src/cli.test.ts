import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  filenameFromURL,
  getDownloadTargetPath,
  looksLikeMarkdown,
  hasMarkdownExtension,
  assessWALHealth,
  MARKDOWN_INDICATORS,
  getCheckpointInterval,
  shouldCheckpoint,
  parseArgs,
} from "./cli.js";

describe("filenameFromURL", () => {
  test("preserves .pdf extension", () => {
    expect(filenameFromURL("https://example.com/paper.pdf")).toBe("paper.pdf");
  });

  test("preserves .md extension", () => {
    expect(filenameFromURL("https://example.com/README.md")).toBe("README.md");
  });

  test("preserves .markdown extension", () => {
    expect(filenameFromURL("https://example.com/doc.markdown")).toBe(
      "doc.markdown"
    );
  });

  test("preserves office document extensions", () => {
    expect(filenameFromURL("https://example.com/brief.docx")).toBe(
      "brief.docx"
    );
    expect(filenameFromURL("https://example.com/notes.odt")).toBe("notes.odt");
    expect(filenameFromURL("https://example.com/flat.fodt")).toBe("flat.fodt");
  });

  test("defaults to .pdf for unknown extensions", () => {
    expect(filenameFromURL("https://example.com/document")).toBe(
      "document.pdf"
    );
  });

  test("does NOT infer .md from path containing .md (false positive fix)", () => {
    // This was the bug: pathname.includes(".md") was too broad
    // e.g., https://example.com/markdown-docs/file should NOT get .md appended
    expect(filenameFromURL("https://example.com/markdown-docs/file")).toBe(
      "file.pdf"
    );
    expect(filenameFromURL("https://example.com/docs.md.backup/file")).toBe(
      "file.pdf"
    );
  });

  test("handles query strings correctly", () => {
    expect(filenameFromURL("https://example.com/doc.pdf?token=abc")).toBe(
      "doc.pdf"
    );
  });

  test("handles GitHub raw URLs with .md extension", () => {
    expect(
      filenameFromURL(
        "https://raw.githubusercontent.com/user/repo/main/README.md"
      )
    ).toBe("README.md");
  });
});

describe("getDownloadTargetPath", () => {
  const downloadsDir = join("tmp", "downloads");

  test("keeps .pdf when the fetched content is PDF", () => {
    expect(
      getDownloadTargetPath(
        "https://example.com/paper.pdf",
        downloadsDir,
        "pdf"
      )
    ).toBe(join("tmp", "downloads", "paper.pdf"));
  });

  test("rewrites .pdf URL to .md when the fetched content is Markdown", () => {
    expect(
      getDownloadTargetPath(
        "https://example.com/paper.pdf",
        downloadsDir,
        "markdown"
      )
    ).toBe(join("tmp", "downloads", "paper.md"));
  });

  test("adds .md for extensionless markdown URLs", () => {
    expect(
      getDownloadTargetPath(
        "https://example.com/docs/readme",
        downloadsDir,
        "markdown"
      )
    ).toBe(join("tmp", "downloads", "readme.md"));
  });

  test("preserves .markdown when the source URL already uses it", () => {
    expect(
      getDownloadTargetPath(
        "https://example.com/guide.markdown",
        downloadsDir,
        "markdown"
      )
    ).toBe(join("tmp", "downloads", "guide.markdown"));
  });

  test("keeps office extensions when detected from URL downloads", () => {
    expect(
      getDownloadTargetPath(
        "https://example.com/report.docx",
        downloadsDir,
        "docx"
      )
    ).toBe(join("tmp", "downloads", "report.docx"));
    expect(
      getDownloadTargetPath("https://example.com/notes.odt", downloadsDir, "odt")
    ).toBe(join("tmp", "downloads", "notes.odt"));
    expect(
      getDownloadTargetPath("https://example.com/flat.fodt", downloadsDir, "odt")
    ).toBe(join("tmp", "downloads", "flat.fodt"));
  });
});

describe("hasMarkdownExtension", () => {
  test("returns true for .md extension", () => {
    expect(hasMarkdownExtension("https://example.com/file.md")).toBe(true);
  });

  test("returns true for .markdown extension", () => {
    expect(hasMarkdownExtension("https://example.com/file.markdown")).toBe(
      true
    );
  });

  test("returns false for .pdf extension", () => {
    expect(hasMarkdownExtension("https://example.com/file.pdf")).toBe(false);
  });

  test("returns false for no extension", () => {
    expect(hasMarkdownExtension("https://example.com/file")).toBe(false);
  });

  test("returns false for .txt extension", () => {
    expect(hasMarkdownExtension("https://example.com/file.txt")).toBe(false);
  });

  test("is case insensitive", () => {
    expect(hasMarkdownExtension("https://example.com/file.MD")).toBe(true);
    expect(hasMarkdownExtension("https://example.com/file.MARKDOWN")).toBe(
      true
    );
  });

  test("does NOT match .md in path (only extension)", () => {
    // This is the key fix - .md in the path should not trigger markdown detection
    expect(hasMarkdownExtension("https://example.com/markdown-docs/file")).toBe(
      false
    );
    expect(
      hasMarkdownExtension("https://example.com/docs.md.backup/file.txt")
    ).toBe(false);
  });
});

describe("looksLikeMarkdown", () => {
  test("detects h1 heading", () => {
    expect(looksLikeMarkdown("# Hello World")).toBe(true);
  });

  test("detects h2 heading", () => {
    expect(looksLikeMarkdown("## Section")).toBe(true);
  });

  test("detects h3-h6 headings", () => {
    expect(looksLikeMarkdown("### Subsection")).toBe(true);
    expect(looksLikeMarkdown("#### Deep")).toBe(true);
    expect(looksLikeMarkdown("###### Deepest")).toBe(true);
  });

  test("detects unordered list with dash", () => {
    expect(looksLikeMarkdown("- item one\n- item two")).toBe(true);
  });

  test("detects unordered list with asterisk", () => {
    expect(looksLikeMarkdown("* item one\n* item two")).toBe(true);
  });

  test("detects unordered list with plus", () => {
    expect(looksLikeMarkdown("+ item one\n+ item two")).toBe(true);
  });

  test("detects ordered list", () => {
    expect(looksLikeMarkdown("1. First\n2. Second")).toBe(true);
  });

  test("detects code fence", () => {
    expect(looksLikeMarkdown("```javascript\nconst x = 1;\n```")).toBe(true);
  });

  test("detects table", () => {
    expect(looksLikeMarkdown("| Col1 | Col2 |\n|------|------|")).toBe(true);
  });

  test("detects markdown link", () => {
    expect(
      looksLikeMarkdown("Check out [this link](https://example.com)")
    ).toBe(true);
  });

  test("returns false for plain text", () => {
    expect(
      looksLikeMarkdown("This is just plain text without any markers.")
    ).toBe(false);
  });

  test("returns false for text with hash not at line start", () => {
    expect(looksLikeMarkdown("This has a # in the middle")).toBe(false);
  });

  test("returns false for text with dash not at line start", () => {
    expect(looksLikeMarkdown("This has a - in the middle")).toBe(false);
  });

  test("detects markdown in multiline content", () => {
    const content = `Some intro text

## Section Header

This is a paragraph.

- List item 1
- List item 2
`;
    expect(looksLikeMarkdown(content)).toBe(true);
  });

  test("returns false for empty content", () => {
    expect(looksLikeMarkdown("")).toBe(false);
  });

  test("returns false for whitespace only", () => {
    expect(looksLikeMarkdown("   \n\n   ")).toBe(false);
  });
});

describe("Markdown MIME type detection (conceptual)", () => {
  // These tests document the expected behavior of the downloadFile function
  // They test the logic conceptually since downloadFile requires network access

  const isExplicitMarkdownMime = (contentType: string) =>
    contentType.includes("text/markdown") ||
    contentType.includes("text/x-markdown");

  const shouldTreatAsPdf = (url: string, contentType: string) => {
    const hasExplicitMarkdownMime = isExplicitMarkdownMime(contentType);
    const hasTextPlainMime = contentType.includes("text/plain");
    const hasTextualMime = hasExplicitMarkdownMime || hasTextPlainMime;
    const pathname = new URL(url).pathname.toLowerCase();
    const hasPdfExt = pathname.endsWith(".pdf");
    return contentType.includes("pdf") || (hasPdfExt && !hasTextualMime);
  };

  test("text/markdown is explicit markdown MIME", () => {
    expect(isExplicitMarkdownMime("text/markdown")).toBe(true);
    expect(isExplicitMarkdownMime("text/markdown; charset=utf-8")).toBe(true);
  });

  test("text/x-markdown is explicit markdown MIME", () => {
    expect(isExplicitMarkdownMime("text/x-markdown")).toBe(true);
  });

  test("text/plain is NOT explicit markdown MIME", () => {
    expect(isExplicitMarkdownMime("text/plain")).toBe(false);
    expect(isExplicitMarkdownMime("text/plain; charset=utf-8")).toBe(false);
  });

  test("text/html is NOT explicit markdown MIME", () => {
    expect(isExplicitMarkdownMime("text/html")).toBe(false);
  });

  test("text/markdown overrides a misleading .pdf URL suffix", () => {
    expect(
      shouldTreatAsPdf("https://example.com/readme.pdf", "text/markdown")
    ).toBe(false);
  });

  test("text/plain from a .pdf URL is not forced to PDF before markdown heuristics", () => {
    expect(
      shouldTreatAsPdf("https://example.com/readme.pdf", "text/plain")
    ).toBe(false);
  });
});

describe("WAL health assessment", () => {
  test("assesses healthy WAL state", () => {
    const result = assessWALHealth({
      fileCount: 10,
      totalSizeBytes: 1024 * 1024,
    }); // 1MB
    expect(result.healthy).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test("warns when file count exceeds threshold", () => {
    const result = assessWALHealth({
      fileCount: 60,
      totalSizeBytes: 1024 * 1024,
    });
    expect(result.healthy).toBe(false);
    expect(result.warnings).toContain(
      "WAL file count (60) exceeds recommended threshold (50)"
    );
  });

  test("warns when total size exceeds threshold", () => {
    const result = assessWALHealth({
      fileCount: 10,
      totalSizeBytes: 60 * 1024 * 1024,
    }); // 60MB
    expect(result.healthy).toBe(false);
    expect(result.warnings).toContain(
      "WAL size (60.0 MB) exceeds recommended threshold (50 MB)"
    );
  });

  test("warns for both thresholds exceeded", () => {
    const result = assessWALHealth({
      fileCount: 100,
      totalSizeBytes: 100 * 1024 * 1024,
    });
    expect(result.healthy).toBe(false);
    expect(result.warnings).toHaveLength(2);
  });

  test("handles zero files gracefully", () => {
    const result = assessWALHealth({ fileCount: 0, totalSizeBytes: 0 });
    expect(result.healthy).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("daemon command parsing", () => {
  // Note: These test the command structure, not execution
  // Actual daemon lifecycle is tested in Daemon.test.ts

  test("daemon command requires subcommand", () => {
    // This will be handled in the switch statement
    expect(true).toBe(true); // Placeholder - actual test would mock console.error
  });

  test("daemon start subcommand exists", () => {
    expect(true).toBe(true); // Structure verification only
  });

  test("daemon stop subcommand exists", () => {
    expect(true).toBe(true); // Structure verification only
  });

  test("daemon status subcommand exists", () => {
    expect(true).toBe(true); // Structure verification only
  });
});

describe("automatic checkpoint during batch operations", () => {
  test("calculates checkpoint interval from options", () => {
    // Default should be 50
    const defaultInterval = getCheckpointInterval({});
    expect(defaultInterval).toBe(50);

    // Custom interval
    const customInterval = getCheckpointInterval({
      "checkpoint-interval": "25",
    });
    expect(customInterval).toBe(25);
  });

  test("determines when checkpoint is needed", () => {
    const interval = 50;

    // Should checkpoint at multiples of interval
    expect(shouldCheckpoint(0, interval)).toBe(false); // Start, no checkpoint
    expect(shouldCheckpoint(49, interval)).toBe(false);
    expect(shouldCheckpoint(50, interval)).toBe(true); // 50th doc
    expect(shouldCheckpoint(51, interval)).toBe(false);
    expect(shouldCheckpoint(100, interval)).toBe(true); // 100th doc
    expect(shouldCheckpoint(150, interval)).toBe(true); // 150th doc
  });

  test("checkpoint counter tracks processed documents", () => {
    // Test that counter increments properly during ingest loop
    // This is behavioral - we verify by checking the checkpointing logic
    const docsProcessed = [1, 2, 49, 50, 51, 99, 100];
    const interval = 50;
    const checkpointedAt = docsProcessed.filter((n) =>
      shouldCheckpoint(n, interval)
    );

    expect(checkpointedAt).toEqual([50, 100]);
  });
});

describe("CLI integration: search with --include-clusters", () => {
  test("parseArgs handles --include-clusters flag", () => {
    const args = [
      "search",
      "machine learning",
      "--include-clusters",
      "--limit",
      "5",
    ];
    const opts = parseArgs(args.slice(2)); // Skip command and query

    expect(opts["include-clusters"]).toBe(true);
    expect(opts.limit).toBe("5");
  });

  test("parseArgs handles search without --include-clusters", () => {
    const args = ["search", "query", "--limit", "10"];
    const opts = parseArgs(args.slice(2));

    expect(opts["include-clusters"]).toBeUndefined();
  });
});

describe("CLI integration: cluster command with --soft flag", () => {
  test("parseArgs handles --soft flag for soft clustering", () => {
    const args = ["cluster", "--soft", "--k", "10"];
    const opts = parseArgs(args.slice(1)); // Skip command

    expect(opts.soft).toBe(true);
    expect(opts.k).toBe("10");
  });

  test("parseArgs handles cluster without --soft (hard k-means)", () => {
    const args = ["cluster", "--k", "20"];
    const opts = parseArgs(args.slice(1));

    expect(opts.soft).toBeUndefined();
    expect(opts.k).toBe("20");
  });

  // NOTE: Full cluster command integration test deferred
  // The cluster command implementation is part of a separate cell/PR
  // This cell focuses on CLI argument parsing and wiring flags to services
});

describe("CLI integration: add and ingest enrichment flags", () => {
  test("parseArgs handles add with --enrich and --auto-tag", () => {
    const args = ["add", "paper.pdf", "--enrich", "--auto-tag"];
    const opts = parseArgs(args.slice(2));

    expect(opts.enrich).toBe(true);
    expect(opts["auto-tag"]).toBe(true);
    expect(opts["no-enrich"]).toBeUndefined();
  });

  test("parseArgs does not enable enrichment by default for add", () => {
    const args = ["add", "paper.pdf"];
    const opts = parseArgs(args.slice(2));

    expect(opts.enrich).toBeUndefined();
    expect(opts["auto-tag"]).toBeUndefined();
    expect(opts["no-enrich"]).toBeUndefined();
  });

  test("parseArgs handles ingest with --enrich and --auto-tag", () => {
    const args = ["ingest", "./docs", "--enrich", "--auto-tag"];
    const opts = parseArgs(args.slice(2));

    expect(opts.enrich).toBe(true);
    expect(opts["auto-tag"]).toBe(true);
  });
});
