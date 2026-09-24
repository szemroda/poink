import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import { Config, Document } from "../types.js";
import { type Concept, TaxonomyService } from "./TaxonomyService.js";
import { DocumentRepository } from "./StorageRepositories.js";
import { makeStorageLayer } from "./StorageLayer.js";

/** Runs `effect` against a fresh in-memory library. */
function runTest<A, E>(
  effect: Effect.Effect<A, E, TaxonomyService | DocumentRepository>,
): Promise<A> {
  const layer = makeStorageLayer(
    new Config({ ...Config.Default, storage: { libsql: { url: ":memory:" } } }),
  );
  return Effect.runPromise(Effect.scoped(Effect.provide(effect, layer)));
}

function sortedIds(concepts: Concept[]): string[] {
  return concepts.map((concept) => concept.id).sort();
}

/** Adds concepts labelled by their ids plus `[concept, broader]` edges. */
const addHierarchy = (ids: string[], edges: Array<[string, string]>) =>
  Effect.gen(function* () {
    const svc = yield* TaxonomyService;
    for (const id of ids) {
      yield* svc.addConcept({ id, prefLabel: id });
    }
    for (const [conceptId, broaderId] of edges) {
      yield* svc.addBroader(conceptId, broaderId);
    }
  });

describe("TaxonomyService - Concept CRUD", () => {
  test("getConcept returns stored concepts and null for unknown ids", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;

        yield* svc.addConcept({
          id: "machine-learning",
          prefLabel: "Machine Learning",
          altLabels: ["ML", "statistical learning"],
          definition: "Algorithms that learn from data",
        });
        yield* svc.addConcept({ id: "typescript", prefLabel: "TypeScript" });

        expect(yield* svc.getConcept("machine-learning")).toMatchObject({
          id: "machine-learning",
          prefLabel: "Machine Learning",
          altLabels: ["ML", "statistical learning"],
          definition: "Algorithms that learn from data",
        });
        const minimal = yield* svc.getConcept("typescript");
        expect(minimal).toMatchObject({ prefLabel: "TypeScript", altLabels: [] });
        expect(minimal?.definition).toBeUndefined();
        expect(yield* svc.getConcept("non-existent")).toBeNull();
      }),
    );
  });

  test("listConcepts returns all concepts ordered by label", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;

        yield* svc.addConcept({ id: "ts", prefLabel: "TypeScript" });
        yield* svc.addConcept({ id: "js", prefLabel: "JavaScript" });
        yield* svc.addConcept({ id: "rust", prefLabel: "Rust" });

        const concepts = yield* svc.listConcepts();
        expect(concepts.map((c) => c.id)).toEqual(["js", "rust", "ts"]);
      }),
    );
  });

  test("updateConcept modifies an existing concept", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;

        yield* svc.addConcept({ id: "ai", prefLabel: "AI" });
        yield* svc.updateConcept("ai", {
          prefLabel: "Artificial Intelligence",
          altLabels: ["AI", "machine intelligence"],
          definition: "Simulation of human intelligence",
        });

        expect(yield* svc.getConcept("ai")).toMatchObject({
          prefLabel: "Artificial Intelligence",
          altLabels: ["AI", "machine intelligence"],
          definition: "Simulation of human intelligence",
        });
      }),
    );
  });
});

describe("TaxonomyService - Hierarchy", () => {
  // cs <- ai <- ml <- dl, and nlp under both ml and linguistics.
  const concepts = ["cs", "ai", "ml", "dl", "nlp", "linguistics"];
  const edges: Array<[string, string]> = [
    ["ai", "cs"],
    ["ml", "ai"],
    ["dl", "ml"],
    ["nlp", "ml"],
    ["nlp", "linguistics"],
  ];

  test("getBroader and getNarrower return direct neighbours, including multiple parents", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;
        yield* addHierarchy(concepts, edges);

        expect(sortedIds(yield* svc.getBroader("ml"))).toEqual(["ai"]);
        expect(sortedIds(yield* svc.getBroader("nlp"))).toEqual(["linguistics", "ml"]);
        expect(sortedIds(yield* svc.getNarrower("ml"))).toEqual(["dl", "nlp"]);
      }),
    );
  });

  test("getAncestors and getDescendants are transitive", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;
        yield* addHierarchy(concepts, edges);

        expect(sortedIds(yield* svc.getAncestors("dl"))).toEqual(["ai", "cs", "ml"]);
        expect(sortedIds(yield* svc.getAncestors("nlp"))).toEqual(["ai", "cs", "linguistics", "ml"]);
        expect(sortedIds(yield* svc.getDescendants("cs"))).toEqual(["ai", "dl", "ml", "nlp"]);
      }),
    );
  });

  test("removeBroader deletes only that parent relationship", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;
        yield* addHierarchy(concepts, edges);

        yield* svc.removeBroader("nlp", "linguistics");

        expect(sortedIds(yield* svc.getBroader("nlp"))).toEqual(["ml"]);
        expect(yield* svc.getNarrower("linguistics")).toEqual([]);
      }),
    );
  });
});

describe("TaxonomyService - Relations", () => {
  test("addRelated and removeRelated act on both directions", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;
        yield* addHierarchy(["js", "ts"], []);

        yield* svc.addRelated("js", "ts");
        expect(sortedIds(yield* svc.getRelated("js"))).toEqual(["ts"]);
        expect(sortedIds(yield* svc.getRelated("ts"))).toEqual(["js"]);

        yield* svc.removeRelated("ts", "js");
        expect(yield* svc.getRelated("js")).toEqual([]);
        expect(yield* svc.getRelated("ts")).toEqual([]);
      }),
    );
  });
});

describe("TaxonomyService - Document Mappings", () => {
  test("assigns, upserts, looks up, and removes document concepts", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;
        const documents = yield* DocumentRepository;
        yield* documents.addDocument(
          new Document({
            id: "doc-1",
            title: "Document",
            path: "/documents/doc-1.md",
            addedAt: new Date("2026-01-01T00:00:00.000Z"),
            pageCount: 1,
            sizeBytes: 100,
            tags: [],
            fileType: "markdown",
            metadata: {},
          }),
        );
        yield* addHierarchy(["ml"], []);

        yield* svc.assignToDocument("doc-1", "ml", 0.5, "llm");
        yield* svc.assignToDocument("doc-1", "ml", 0.95, "manual");

        const assignment = { docId: "doc-1", conceptId: "ml", confidence: 0.95, source: "manual" };
        expect(yield* svc.getDocumentConcepts("doc-1")).toEqual([assignment]);
        expect(yield* svc.getConceptDocuments("ml")).toEqual([assignment]);

        yield* svc.removeFromDocument("doc-1", "ml");
        expect(yield* svc.getDocumentConcepts("doc-1")).toEqual([]);
      }),
    );
  });

  test("rejects assignments to unknown documents", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;
        yield* addHierarchy(["ml"], []);

        const error = yield* Effect.flip(svc.assignToDocument("doc-404", "ml"));

        expect(error._tag).toBe("TaxonomyError");
        expect(yield* svc.getConceptDocuments("ml")).toEqual([]);
      }),
    );
  });
});

describe("TaxonomyService - Bulk Operations", () => {
  test("seedFromJSON loads concepts, hierarchy, and symmetric relations idempotently", async () => {
    await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;
        const taxonomy = {
          concepts: [
            { id: "cs", prefLabel: "Computer Science" },
            { id: "ai", prefLabel: "Artificial Intelligence" },
            { id: "ml", prefLabel: "Machine Learning" },
          ],
          hierarchy: [
            { conceptId: "ai", broaderId: "cs" },
            { conceptId: "ml", broaderId: "ai" },
          ],
          relations: [{ conceptId: "ml", relatedId: "cs" }],
        };

        yield* svc.seedFromJSON(taxonomy);
        yield* svc.seedFromJSON(taxonomy);

        expect(sortedIds(yield* svc.listConcepts())).toEqual(["ai", "cs", "ml"]);
        expect(sortedIds(yield* svc.getAncestors("ml"))).toEqual(["ai", "cs"]);
        expect(sortedIds(yield* svc.getRelated("cs"))).toEqual(["ml"]);
      }),
    );
  });
});

describe("TaxonomyService - Concept Embeddings", () => {
  test("storeConceptEmbedding initializes vector schema on a fresh database", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const svc = yield* TaxonomyService;
        yield* addHierarchy(["concept-vector"], []);
        yield* svc.storeConceptEmbedding("concept-vector", [1, 0, 0]);
        return yield* svc.findSimilarConcepts([1, 0, 0], 0.1, 5);
      }),
    );

    expect(sortedIds(result)).toEqual(["concept-vector"]);
  });

  test("findSimilarConcepts returns empty results before vector schema exists", async () => {
    const result = await runTest(
      Effect.flatMap(TaxonomyService, (svc) =>
        svc.findSimilarConcepts([1, 0, 0], 0.1, 5),
      ),
    );

    expect(result).toEqual([]);
  });
});
