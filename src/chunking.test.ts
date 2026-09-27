import { describe, expect, test } from "vitest";
import {
  applyAdjacentChunkOverlap,
  assessDocChunker,
  assertValidChunking,
  buildChunkerMetadata,
  buildChunkOverlapPrefix,
  chunkNormalizedText,
  parseChunkerMetadata,
} from "./chunking.js";
import { Document } from "./types.js";

const CONFIG = { chunkSize: 512, chunkOverlap: 50 };

test("rejects invalid chunking config when overlap is not smaller than chunk size", () => {
  expect(() => assertValidChunking(100, 100)).toThrow(
    "chunkOverlap (100) must be smaller than chunkSize (100)",
  );
  expect(() =>
    buildChunkerMetadata("pdf", { chunkSize: 100, chunkOverlap: 150 }),
  ).toThrow("chunkOverlap (150) must be smaller than chunkSize (100)");
});

describe("chunk overlap helpers", () => {
  test("uses complete trailing sentences for overlap when possible", () => {
    expect(
      buildChunkOverlapPrefix("First sentence. Second sentence. Third sentence.", 20),
    ).toBe("Third sentence.");
  });

  test("prefixes each chunk with the previous chunk's trailing sentences", () => {
    expect(
      applyAdjacentChunkOverlap(
        ["Alpha starts here. Beta carries forward.", "Gamma starts the next chunk."],
        24,
      ),
    ).toEqual([
      "Alpha starts here. Beta carries forward.",
      "Beta carries forward.\n\nGamma starts the next chunk.",
    ]);
  });
});

test("chunkNormalizedText hard-splits oversized text and preserves short trailing chunks", () => {
  expect(chunkNormalizedText("x".repeat(65), 30, 0)).toEqual([
    "x".repeat(30),
    "x".repeat(30),
    "x".repeat(5),
  ]);
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

  test.each([
    { name: "null", value: null },
    {
      name: "a string version",
      value: { id: "test-chunker", version: "2", unit: "chars", chunkSize: 512, chunkOverlap: 50 },
    },
  ])("rejects $name", ({ value }) => {
    expect(parseChunkerMetadata(value)).toBeNull();
  });

  const current = buildChunkerMetadata("markdown", CONFIG);

  test.each([
    { name: "matching metadata", chunker: current, code: "ok" },
    { name: "missing metadata", chunker: undefined, code: "missing_metadata" },
    { name: "an older chunker version", chunker: { ...current, version: 1 }, code: "id_version_mismatch" },
    { name: "a different chunk size", chunker: { ...current, chunkSize: 1024 }, code: "config_mismatch" },
  ])("assesses $name as $code", ({ chunker, code }) => {
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

    expect(assessDocChunker(document, CONFIG)).toMatchObject({
      needsRechunk: code !== "ok",
      code,
      expected: current,
    });
  });
});
