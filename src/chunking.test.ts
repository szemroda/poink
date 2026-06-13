import { describe, expect, test } from "vitest";
import {
  applyAdjacentChunkOverlap,
  assessDocChunker,
  assertValidChunking,
  buildChunkerMetadata,
  buildChunkOverlapPrefix,
  chunkNormalizedText,
  inferFileTypeFromPath,
  parseChunkerMetadata,
} from "./chunking.js";
import { Document } from "./types.js";

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

describe("chunk overlap helpers", () => {
  test("uses complete trailing sentences for overlap when possible", () => {
    const overlap = buildChunkOverlapPrefix(
      "First sentence. Second sentence. Third sentence.",
      20,
    );

    expect(overlap).toBe("Third sentence.");
  });

  test("applies adjacent overlap between chunks", () => {
    const chunks = applyAdjacentChunkOverlap(
      [
        "Alpha starts here. Beta carries forward.",
        "Gamma starts the next chunk.",
      ],
      24,
    );

    expect(chunks[0]).toBe("Alpha starts here. Beta carries forward.");
    expect(chunks[1]).toBe(
      "Beta carries forward.\n\nGamma starts the next chunk.",
    );
  });
});

describe("normalized text chunking", () => {
  test("hard-splits oversized text and filters short trailing chunks", () => {
    expect(chunkNormalizedText("x".repeat(65), 30, 0)).toEqual([
      "x".repeat(30),
      "x".repeat(30),
    ]);
  });
});

describe("chunker metadata", () => {
  test("parses valid metadata from an unknown value", () => {
    const metadata = {
      id: "test-chunker",
      version: 2,
      unit: "chars",
      chunkSize: 512,
      chunkOverlap: 50,
    };

    expect(parseChunkerMetadata(metadata)).toEqual(metadata);
  });

  test("rejects incomplete or incorrectly typed metadata", () => {
    expect(parseChunkerMetadata(null)).toBeNull();
    expect(
      parseChunkerMetadata({
        id: "test-chunker",
        version: "2",
        unit: "chars",
        chunkSize: 512,
        chunkOverlap: 50,
      }),
    ).toBeNull();
  });

  test("recognizes matching metadata on a document", () => {
    const config = { chunkSize: 512, chunkOverlap: 50 };
    const chunker = buildChunkerMetadata("markdown", config);
    const document = new Document({
      id: "doc-1",
      title: "Notes",
      path: "notes.md",
      addedAt: new Date("2024-01-01T00:00:00Z"),
      pageCount: 1,
      sizeBytes: 123,
      tags: [],
      fileType: "markdown",
      metadata: { chunker },
    });

    expect(assessDocChunker(document, config)).toMatchObject({
      needsRechunk: false,
      code: "ok",
      reason: "ok",
      expected: chunker,
      actual: chunker,
    });
  });
});
