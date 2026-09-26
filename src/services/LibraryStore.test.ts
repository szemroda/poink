import { Effect, Either, Layer } from "effect";
import { describe, expect, test } from "vitest";
import { AmbiguousDocumentError, Config, Document, SearchOptions } from "../types.js";
import { LibraryStore, makeLibraryStore } from "./LibraryStore.js";
import { makeStorageLayer } from "./StorageLayer.js";
import { DocumentRepository } from "./StorageRepositories.js";

const config = new Config({
  ...Config.Default,
  storage: { libsql: { url: ":memory:" } },
});

function makeDocument(id: string, title: string, addedAt: string): Document {
  return new Document({
    id,
    title,
    path: `/documents/${id}.md`,
    addedAt: new Date(addedAt),
    pageCount: 1,
    sizeBytes: 100,
    tags: [],
    fileType: "markdown",
    metadata: {},
  });
}

/** Runs `use` against a fresh in-memory library seeded with `documents`. */
function runLibrary<A, E>(
  documents: readonly Document[],
  use: (
    library: Effect.Effect.Success<typeof LibraryStore>,
    repository: Effect.Effect.Success<typeof DocumentRepository>,
  ) => Effect.Effect<A, E>,
) {
  const storage = makeStorageLayer(config);
  const layer = Layer.merge(
    storage,
    makeLibraryStore(config).pipe(Layer.provide(storage)),
  );
  return Effect.runPromise(
    Effect.either(
      Effect.gen(function* () {
        const repository = yield* DocumentRepository;
        for (const document of documents) {
          yield* repository.addDocument(document);
        }
        return yield* use(yield* LibraryStore, repository);
      }),
    ).pipe(Effect.provide(layer), Effect.scoped),
  );
}

const remainingIds = (repository: Effect.Effect.Success<typeof DocumentRepository>) =>
  Effect.map(repository.listDocuments(), (docs) => docs.map((doc) => doc.id).sort());

describe("LibraryStore document resolution", () => {
  const report = makeDocument("aaa111", "Report", "2026-01-01T00:00:00Z");
  const appendix = makeDocument("bbb222", "Report appendix", "2026-02-01T00:00:00Z");

  test("prefers an exact title over a newer partial title match", async () => {
    const result = await runLibrary([report, appendix], (library, repository) =>
      Effect.gen(function* () {
        const removed = yield* library.remove("report");
        return { removed: removed.id, remaining: yield* remainingIds(repository) };
      }),
    );

    expect(result).toEqual(
      Either.right({ removed: "aaa111", remaining: ["bbb222"] }),
    );
  });

  test("accepts a unique partial title or ID prefix", async () => {
    const result = await runLibrary([report, appendix], (library) =>
      Effect.all([library.get("appendix"), library.get("aaa")]),
    );

    expect(Either.map(result, (docs) => docs.map((doc) => doc?.id))).toEqual(
      Either.right(["bbb222", "aaa111"]),
    );
  });

  test.each([
    ["a shared partial title", [report, appendix], "Repo", ["aaa111", "bbb222"]],
    [
      "duplicate exact titles",
      [report, makeDocument("ccc333", "Report", "2026-03-01T00:00:00Z")],
      "Report",
      ["aaa111", "ccc333"],
    ],
    [
      "an ambiguous ID prefix",
      [makeDocument("abc1", "One", "2026-01-01T00:00:00Z"), makeDocument("abc2", "Two", "2026-01-02T00:00:00Z")],
      "abc",
      ["abc1", "abc2"],
    ],
  ] as const)("refuses to mutate on %s", async (_name, documents, query, ids) => {
    const result = await runLibrary(documents, (library, repository) =>
      Effect.gen(function* () {
        const removal = yield* Effect.either(library.remove(query));
        const tagging = yield* Effect.either(library.tag(query, ["x"]));
        const docs = yield* repository.listDocuments();
        return { removal, tagging, docs };
      }),
    );

    const { removal, tagging, docs } = Either.getOrThrow(result);
    for (const outcome of [removal, tagging]) {
      const error = Either.flip(outcome).pipe(Either.getOrThrow);
      expect(error).toBeInstanceOf(AmbiguousDocumentError);
      expect(error).toMatchObject({ candidates: expect.arrayContaining([...ids]) });
    }
    expect(docs.map((doc) => doc.id).sort()).toEqual([...ids].sort());
    expect(docs.every((doc) => doc.tags.length === 0)).toBe(true);
  });
});

describe("LibraryStore.ftsSearch", () => {
  test("expands matches with neighboring chunks", async () => {
    const doc = makeDocument("doc-1", "Doc", "2026-01-01T00:00:00Z");
    const result = await runLibrary([doc], (library, repository) =>
      Effect.gen(function* () {
        yield* repository.addChunks([
          { id: "doc-1-0", docId: "doc-1", page: 1, chunkIndex: 0, content: "unique target" },
          { id: "doc-1-1", docId: "doc-1", page: 1, chunkIndex: 1, content: "neighbor context" },
        ]);
        return yield* library.ftsSearch(
          "unique",
          new SearchOptions({ hybrid: false, expandChars: 1000 }),
        );
      }),
    );

    expect(Either.getOrThrow(result)).toEqual([
      expect.objectContaining({
        content: "unique target",
        expandedContent: "unique target\nneighbor context",
      }),
    ]);
  });
});
