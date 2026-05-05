import { describe, expect, test } from "bun:test";
import {
  assertValidChunking,
  buildChunkerMetadata,
  inferFileTypeFromPath,
} from "./chunking.js";

describe("document file type inference", () => {
  test("infers supported document types from path extensions", () => {
    expect(inferFileTypeFromPath("paper.pdf")).toBe("pdf");
    expect(inferFileTypeFromPath("notes.md")).toBe("markdown");
    expect(inferFileTypeFromPath("notes.markdown")).toBe("markdown");
    expect(inferFileTypeFromPath("brief.docx")).toBe("docx");
    expect(inferFileTypeFromPath("draft.odt")).toBe("odt");
    expect(inferFileTypeFromPath("draft.fodt")).toBe("odt");
  });

  test("builds chunker metadata for office document types", () => {
    const config = { chunkSize: 512, chunkOverlap: 50 };

    expect(buildChunkerMetadata("docx", config).id).toContain("docx");
    expect(buildChunkerMetadata("odt", config).id).toContain("odt");
  });

  test("rejects invalid chunking config when overlap is not smaller than chunk size", () => {
    expect(() => assertValidChunking(100, 100)).toThrow(
      "chunkOverlap (100) must be smaller than chunkSize (100)",
    );
    expect(() =>
      buildChunkerMetadata("pdf", { chunkSize: 100, chunkOverlap: 150 }),
    ).toThrow(
      "chunkOverlap (150) must be smaller than chunkSize (100)",
    );
  });
});
