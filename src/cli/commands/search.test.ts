import { describe, expect, test } from "vitest";
import { DocumentSearchResult } from "../../types.js";
import { toSearchDocumentOutput } from "./search.js";

function makeResult(
  overrides: Partial<DocumentSearchResult> = {},
): DocumentSearchResult {
  return new DocumentSearchResult({
    chunkId: "chunk-1",
    docId: "doc-1",
    title: "Example",
    page: 2,
    chunkIndex: 3,
    content: "matching chunk",
    score: 0.8,
    rawScore: 0.75,
    scoreType: "cosine_similarity",
    vectorScore: 0.75,
    matchType: "vector",
    entityType: "document",
    expandedContent: "context before\nmatching chunk\ncontext after",
    expandedRange: { start: 2, end: 4 },
    ...overrides,
  });
}

describe("search output projection", () => {
  test("returns matching chunk content without expansion", () => {
    const output = toSearchDocumentOutput(makeResult(), 0);

    expect(output.content).toBe("matching chunk");
    expect(output).not.toHaveProperty("expandedContent");
    expect(output).not.toHaveProperty("rawScore");
    expect(output).not.toHaveProperty("scoreType");
    expect(output).not.toHaveProperty("vectorScore");
    expect(output).not.toHaveProperty("ftsRank");
    expect(output).not.toHaveProperty("diagnostics");
  });

  test("replaces content with expanded context when requested", () => {
    const output = toSearchDocumentOutput(makeResult(), 1000);

    expect(output.content).toBe(
      "context before\nmatching chunk\ncontext after",
    );
    expect(output).not.toHaveProperty("expandedContent");
  });

  test("falls back to matching content when expansion is unavailable", () => {
    const output = toSearchDocumentOutput(
      makeResult({ expandedContent: undefined }),
      1000,
    );

    expect(output.content).toBe("matching chunk");
  });

  test("groups diagnostics in verbose mode", () => {
    const output = toSearchDocumentOutput(makeResult(), 1000, true);

    expect(output.diagnostics).toEqual({
      chunkIndex: 3,
      rawScore: 0.75,
      scoreType: "cosine_similarity",
      vectorScore: 0.75,
      expandedRange: { start: 2, end: 4 },
    });
    expect(output).not.toHaveProperty("rawScore");
    expect(output).not.toHaveProperty("expandedContent");
  });
});
