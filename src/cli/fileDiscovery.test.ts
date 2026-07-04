import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  combineIngestDiscoveryResults,
  discoverIngestFiles,
  globPatternsFromOption,
  normalizeGlobPath,
} from "./fileDiscovery.js";

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "poink-discovery-test-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("ingest file discovery", () => {
  test("filters supported candidates with include and exclude globs", () => {
    withTempDirectory((root) => {
      mkdirSync(join(root, "keep"));
      mkdirSync(join(root, "archive"));
      writeFileSync(join(root, "keep", "note.md"), "# Keep", "utf-8");
      writeFileSync(join(root, "keep", "paper.pdf"), "%PDF-1.7", "utf-8");
      writeFileSync(join(root, "archive", "old.md"), "# Old", "utf-8");
      writeFileSync(join(root, "ignored.txt"), "plain text", "utf-8");

      const result = discoverIngestFiles(
        root,
        {
          include: ["**/*.md"],
          exclude: ["**/archive/**"],
        },
        true,
      );

      expect(result.files).toEqual([join(root, "keep", "note.md")]);
      expect(result.selection).toEqual({
        include: ["**/*.md"],
        exclude: ["**/archive/**"],
        discovered: 3,
        included: 2,
        excluded: 1,
        selected: 1,
        sampled: 1,
      });
    });
  });

  test("dedupes selection counters when combining overlapping roots", () => {
    withTempDirectory((root) => {
      const nested = join(root, "nested");
      mkdirSync(join(nested, "archive"), { recursive: true });
      writeFileSync(join(nested, "note.md"), "# Keep", "utf-8");
      writeFileSync(join(nested, "archive", "old.md"), "# Old", "utf-8");

      const filters = {
        include: ["**/*.md"],
        exclude: ["**/archive/**"],
      };
      const combined = combineIngestDiscoveryResults(
        [
          discoverIngestFiles(root, filters, true),
          discoverIngestFiles(nested, filters, true),
        ],
        filters,
      );

      expect(combined.files).toEqual([join(nested, "note.md")]);
      expect(combined.selection).toEqual({
        include: ["**/*.md"],
        exclude: ["**/archive/**"],
        discovered: 2,
        included: 2,
        excluded: 1,
        selected: 1,
        sampled: 1,
      });
    });
  });

  test("keeps excluded paths out when overlapping roots disagree", () => {
    withTempDirectory((root) => {
      const nested = join(root, "nested");
      mkdirSync(join(nested, "archive"), { recursive: true });
      writeFileSync(join(nested, "archive", "old.md"), "# Old", "utf-8");

      const filters = {
        include: ["**/*.md"],
        exclude: ["archive/**"],
      };
      const combined = combineIngestDiscoveryResults(
        [
          discoverIngestFiles(root, filters, true),
          discoverIngestFiles(nested, filters, true),
        ],
        filters,
      );

      expect(combined.files).toEqual([]);
      expect(combined.selection).toEqual({
        include: ["**/*.md"],
        exclude: ["archive/**"],
        discovered: 1,
        included: 1,
        excluded: 1,
        selected: 0,
        sampled: 0,
      });
    });
  });

  test("normalizes Windows separators before glob matching", () => {
    expect(normalizeGlobPath("research\\2026\\note.md")).toBe(
      "research/2026/note.md",
    );
  });

  test("coerces repeatable option values without accepting non-strings", () => {
    expect(globPatternsFromOption(undefined)).toEqual([]);
    expect(globPatternsFromOption("**/*.md")).toEqual(["**/*.md"]);
    expect(globPatternsFromOption(["**/*.md", 3, false, "**/*.pdf"])).toEqual([
      "**/*.md",
      "**/*.pdf",
    ]);
  });
});
