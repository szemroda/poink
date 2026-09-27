import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { getPathFilename } from "../pathUtils.js";
import { insertDocument } from "../testUtils.js";
import { Config, Document } from "../types.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import { LibSQLClient, makeLibSQLClient } from "./LibSQLClient.js";
import { makeLibSQLRepositories } from "./LibSQLRepositories.js";
import { makeTaxonomyService, TaxonomyService } from "./TaxonomyService.js";
import {
  AutoTagger,
  cleanTitle,
  type EnrichmentResult,
  EnrichmentError,
  extractAuthor,
  extractFilenameTags,
  extractPathTags,
  makeAutoTagger,
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

describe("AutoTagger.assignConcepts", () => {
  it("assigns known concepts and accepted proposals to the document", async () => {
    const config = new Config({
      ...Config.Default,
      storage: { libsql: { url: ":memory:" } },
    });
    // Exposes the raw client too: no service reads document_concepts back.
    const storage = Layer.merge(
      makeLibSQLRepositories(),
      makeTaxonomyService(),
    ).pipe(Layer.provideMerge(makeLibSQLClient(config)));
    const embeddings = Layer.succeed(EmbeddingProvider, {
      provider: "ollama",
      checkHealth: () => Effect.void,
      embed: () => Effect.succeed([0, 1, 0]),
      embedBatch: (texts) => Effect.succeed(texts.map(() => [0, 1, 0])),
    });
    const layer = Layer.mergeAll(
      storage,
      makeAutoTagger(config).pipe(
        Layer.provide(Layer.merge(storage, embeddings)),
      ),
    );
    const enrichment: EnrichmentResult = {
      title: "Notes",
      summary: "Summary.",
      documentType: "notes",
      category: "programming",
      tags: [],
      concepts: ["programming/rust", "programming/unknown"],
      proposedConcepts: [{ id: "programming/zig", prefLabel: "Zig" }],
      confidence: 0.9,
      provider: "ollama",
    };

    const assigned = await Effect.runPromise(
      Effect.gen(function* () {
        const taxonomy = yield* TaxonomyService;
        yield* insertDocument(
          new Document({
            id: "doc-1",
            title: "Notes",
            path: "/notes.md",
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 1,
            tags: [],
            fileType: "markdown",
            metadata: {},
          }),
        );
        yield* taxonomy.addConcept({ id: "programming/rust", prefLabel: "Rust" });

        const tagger = yield* AutoTagger;
        yield* tagger.assignConcepts("doc-1", enrichment);
        const { client } = yield* LibSQLClient;
        return yield* Effect.promise(() =>
          client.execute(
            "SELECT concept_id FROM document_concepts WHERE doc_id = 'doc-1'",
          ),
        );
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    expect(assigned.rows.map((row) => row.concept_id).sort()).toEqual([
      "programming/rust",
      "programming/zig",
    ]);
  });
});
