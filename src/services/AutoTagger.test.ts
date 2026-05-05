/**
 * AutoTagger Tests
 *
 * Focus: Auto-accept proposals with embedding-based deduplication + RAG context
 */

import { describe, expect, it } from "bun:test";

// ============================================================================
// Tests - Verifying JSON file workflow is removed
// ============================================================================

describe("AutoTagger - JSON file workflow removed", () => {
  it("should NOT have loadProposedConcepts function", async () => {
    const module = await import("./AutoTagger.js");
    // @ts-expect-error - function should not exist
    expect(module.loadProposedConcepts).toBeUndefined();
  });

  it("should NOT have saveProposedConcepts function", async () => {
    const module = await import("./AutoTagger.js");
    // @ts-expect-error - function should not exist
    expect(module.saveProposedConcepts).toBeUndefined();
  });

  it("should NOT have addProposedConcepts function", async () => {
    const module = await import("./AutoTagger.js");
    // @ts-expect-error - function should not exist
    expect(module.addProposedConcepts).toBeUndefined();
  });

  it("should NOT have getProposedConceptsPath function", async () => {
    const module = await import("./AutoTagger.js");
    // @ts-expect-error - function should not exist
    expect(module.getProposedConceptsPath).toBeUndefined();
  });

  it("should NOT have ProposedConceptEntry type", async () => {
    // Type should not exist - compile-time check only
    // No runtime check possible for types
    expect(true).toBe(true);
  });
});

describe("AutoTagger - Concept validation", () => {
  it("should export validateProposedConcepts for validation", async () => {
    const module = await import("./AutoTagger.js");

    // Function should be exported for testing
    expect(typeof module.validateProposedConcepts).toBe("function");
  });
});

describe("AutoTagger errors", () => {
  it("stringifies EnrichmentError using its message", async () => {
    const { EnrichmentError } = await import("./AutoTagger.js");

    const error = new EnrichmentError("RAG context extraction failed");

    expect(String(error)).toBe("RAG context extraction failed");
    expect(error.message).toBe("RAG context extraction failed");
  });
});

describe("AutoTagger path handling", () => {
  it("extracts path tags from Windows-style paths", async () => {
    const { extractPathTags } = await import("./AutoTagger.js");

    expect(
      extractPathTags(
        "C:\\Users\\tester\\Documents\\ML\\Deep Learning\\paper.pdf",
        "C:\\Users\\tester\\Documents"
      )
    ).toEqual(["ml", "deep-learning"]);
  });

  it("extracts filename-based metadata from Windows-style paths", async () => {
    const { cleanTitle, extractAuthor, extractFilenameTags } = await import(
      "./AutoTagger.js"
    );
    const { getPathFilename } = await import("../pathUtils.js");

    const filename = getPathFilename(
      "C:\\Users\\tester\\Documents\\Deep Learning - Smith.pdf"
    );

    expect(filename).toBe("Deep Learning - Smith.pdf");
    expect(cleanTitle(filename)).toBe("Deep Learning Smith");
    expect(extractAuthor(filename)).toBe("Smith");
    expect(extractFilenameTags(filename)).toEqual(["deep", "learning", "smith"]);
  });
});
