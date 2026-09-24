import { describe, expect, it } from "vitest";
import { getPathFilename } from "../pathUtils.js";
import {
  cleanTitle,
  EnrichmentError,
  extractAuthor,
  extractFilenameTags,
  extractPathTags,
  validateProposedConcepts,
} from "./AutoTagger.js";

describe("validateProposedConcepts", () => {
  it("normalizes strict structured-output concept fields", () => {
    expect(
      validateProposedConcepts([
        {
          id: "education/spaced-repetition",
          prefLabel: "Spaced Repetition",
          altLabels: null,
          definition: null,
        },
      ]),
    ).toEqual([
      {
        id: "education/spaced-repetition",
        prefLabel: "Spaced Repetition",
        altLabels: [],
        definition: undefined,
      },
    ]);
  });

  it.each([
    ["an id without a parent", "rust", "Rust"],
    ["a nested id", "programming/rust/async", "Async Rust"],
    ["an unknown parent", "cooking/rust", "Rust"],
    ["a generic child", "programming/new", "New"],
    ["an uppercase id", "programming/Rust", "Rust"],
    ["a child with too many words", "programming/one-two-three-four-five", "Five Words"],
    ["a sentence-like label", "programming/rust", "A language that is memory safe"],
    ["an empty label", "programming/rust", ""],
  ])("drops %s", (_name, id, prefLabel) => {
    expect(validateProposedConcepts([{ id, prefLabel }])).toEqual([]);
  });
});

describe("EnrichmentError", () => {
  it("stringifies to its message", () => {
    expect(String(new EnrichmentError("RAG context extraction failed"))).toBe(
      "RAG context extraction failed",
    );
  });
});

describe("path handling", () => {
  it("extracts path tags from Windows-style paths", () => {
    expect(
      extractPathTags(
        "C:\\Users\\tester\\Documents\\ML\\Deep Learning\\paper.pdf",
        "C:\\Users\\tester\\Documents",
      ),
    ).toEqual(["ml", "deep-learning"]);
  });

  it("extracts filename-based metadata from Windows-style paths", () => {
    const filename = getPathFilename(
      "C:\\Users\\tester\\Documents\\Deep Learning - Smith.pdf",
    );

    expect(filename).toBe("Deep Learning - Smith.pdf");
    expect(cleanTitle(filename)).toBe("Deep Learning Smith");
    expect(extractAuthor(filename)).toBe("Smith");
    expect(extractFilenameTags(filename)).toEqual(["deep", "learning", "smith"]);
  });
});
