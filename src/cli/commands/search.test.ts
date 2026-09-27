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
    expandedContent: "context before\nmatching chunk\ncontext after",
    ...overrides,
  });
}

describe("search output projection", () => {
  test("returns only the compact fields with the matching chunk content", () => {
    expect(toSearchDocumentOutput(makeResult(), 0)).toEqual({
      chunkId: "chunk-1",
      docId: "doc-1",
      title: "Example",
      page: 2,
      score: 0.8,
      matchType: "vector",
      content: "matching chunk",
    });
  });

  test.each([
    [
      "uses expanded context when requested",
      {},
      "context before\nmatching chunk\ncontext after",
    ],
    [
      "falls back to matching content when expansion is unavailable",
      { expandedContent: undefined },
      "matching chunk",
    ],
  ])("%s", (_name, overrides, content) => {
    const output = toSearchDocumentOutput(makeResult(overrides), 1000);

    expect(output.content).toBe(content);
    expect(output).not.toHaveProperty("expandedContent");
  });

  test("groups diagnostics in verbose mode", () => {
    const output = toSearchDocumentOutput(makeResult(), 1000, true);

    expect(output.diagnostics).toEqual({
      chunkIndex: 3,
      rawScore: 0.75,
      scoreType: "cosine_similarity",
      vectorScore: 0.75,
    });
    expect(output).not.toHaveProperty("rawScore");
    expect(output).not.toHaveProperty("expandedContent");
  });
});
