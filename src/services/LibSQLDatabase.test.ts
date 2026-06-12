import { createClient } from "@libsql/client";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Config, Document, SearchOptions } from "../types.js";
import { removeDirWithRetries } from "../testUtils.js";
import {
  DocumentRepository,
  LibraryMaintenance,
  SearchRepository,
  StorageError,
} from "./StorageRepositories.js";
import { makeStorageLayer } from "./StorageLayer.js";
import { TaxonomyService } from "./TaxonomyService.js";
import { classifyLibsqlUrl } from "./LibSQLSchema.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await removeDirWithRetries(directory, 300, 100);
  }
}, 30_000);

function makeConfig(url = ":memory:", authTokenEnv?: string): Config {
  return new Config({
    ...Config.Default,
    storage: {
      libsql: {
        url,
        ...(authTokenEnv ? { authTokenEnv } : {}),
      },
    },
  });
}

function makeDocument(id = "doc-1"): Document {
  return new Document({
    id,
    title: "Document",
    path: `/documents/${id}.md`,
    addedAt: new Date("2026-01-01T00:00:00.000Z"),
    pageCount: 1,
    sizeBytes: 100,
    tags: ["test"],
    fileType: "markdown",
    metadata: { source: "test" },
  });
}

function runStorage<A, E>(
  config: Config,
  effect: Effect.Effect<
    A,
    E,
    | DocumentRepository
    | SearchRepository
    | LibraryMaintenance
    | TaxonomyService
  >,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(makeStorageLayer(config)))),
  );
}

describe("libSQL storage", () => {
  test("classifies local, in-memory, and remote URLs", () => {
    expect(classifyLibsqlUrl(":memory:")).toBe("memory");
    expect(classifyLibsqlUrl("file::memory:?cache=shared")).toBe("memory");
    expect(classifyLibsqlUrl("file:./library.db")).toBe("local");
    expect(classifyLibsqlUrl("libsql://example.turso.io")).toBe("remote");
    expect(classifyLibsqlUrl("https://example.turso.io")).toBe("remote");
  });

  test("shares one database across document and taxonomy services", async () => {
    await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        const taxonomy = yield* TaxonomyService;
        const doc = makeDocument();

        yield* documents.addDocument(doc);
        yield* taxonomy.addConcept({
          id: "concept-1",
          prefLabel: "Concept",
        });
        yield* taxonomy.assignToDocument(doc.id, "concept-1");

        expect(yield* documents.getDocument(doc.id)).toEqual(doc);
        expect(yield* taxonomy.getDocumentConcepts(doc.id)).toEqual([
          {
            docId: doc.id,
            conceptId: "concept-1",
            confidence: 1,
            source: "llm",
          },
        ]);
      }),
    );
  });

  test("atomically replaces a document, chunks, and embeddings", async () => {
    await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        const maintenance = yield* LibraryMaintenance;
        const doc = makeDocument();

        yield* documents.replaceDocument(
          doc,
          [
            {
              id: "chunk-1",
              docId: doc.id,
              page: 1,
              chunkIndex: 0,
              content: "first content",
            },
          ],
          [{ chunkId: "chunk-1", embedding: [1, 0, 0] }],
        );

        const updated = new Document({ ...doc, title: "Updated" });
        yield* documents.replaceDocument(
          updated,
          [
            {
              id: "chunk-2",
              docId: doc.id,
              page: 1,
              chunkIndex: 0,
              content: "second content",
            },
          ],
          [{ chunkId: "chunk-2", embedding: [0, 1, 0] }],
        );

        expect((yield* documents.getDocument(doc.id))?.title).toBe("Updated");
        expect(
          (yield* documents.listChunksByDocument(doc.id)).map(
            (chunk) => chunk.id,
          ),
        ).toEqual(["chunk-2"]);
        expect(yield* maintenance.getStats()).toEqual({
          documents: 1,
          chunks: 1,
          embeddings: 1,
        });
      }),
    );
  });

  test("rolls back a failed multi-table replacement", async () => {
    await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        const doc = makeDocument();
        const result = yield* Effect.either(
          documents.replaceDocument(
            doc,
            [
              {
                id: "chunk-1",
                docId: doc.id,
                page: 1,
                chunkIndex: 0,
                content: "content",
              },
            ],
            [{ chunkId: "missing-chunk", embedding: [1, 0, 0] }],
          ),
        );

        expect(result._tag).toBe("Left");
        expect(yield* documents.getDocument(doc.id)).toBeNull();
        expect(yield* documents.listChunksByDocument(doc.id)).toEqual([]);
      }),
    );
  });

  test("returns no vector results before a dimension is established", async () => {
    await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const search = yield* SearchRepository;
        expect(yield* search.vectorSearch([1, 0, 0])).toEqual([]);
      }),
    );
  });

  test("preserves FTS and vector search scoring behavior", async () => {
    await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        const search = yield* SearchRepository;
        const doc = makeDocument();
        yield* documents.replaceDocument(
          doc,
          [
            {
              id: "chunk-1",
              docId: doc.id,
              page: 1,
              chunkIndex: 0,
              content: "semantic storage architecture",
            },
          ],
          [{ chunkId: "chunk-1", embedding: [1, 0, 0] }],
        );

        const vector = yield* search.vectorSearch(
          [1, 0, 0],
          new SearchOptions({ limit: 5 }),
        );
        const fts = yield* search.ftsSearch(
          "storage",
          new SearchOptions({ limit: 5 }),
        );
        expect(vector[0]?.chunkId).toBe("chunk-1");
        expect(vector[0]?.scoreType).toBe("cosine_similarity");
        expect(fts[0]?.chunkId).toBe("chunk-1");
        expect(fts[0]?.scoreType).toBe("fts_rank");
      }),
    );
  });

  test("upgrades supported legacy columns during centralized startup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "poink-schema-"));
    tempDirs.push(directory);
    const url = `file:${join(directory, "library.db")}`;
    const client = createClient({ url });
    await client.execute(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        added_at TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}'
      )
    `);
    await client.execute(`
      INSERT INTO documents
        (id, title, path, added_at, page_count, size_bytes, tags, metadata)
      VALUES
        ('legacy', 'Legacy', '/legacy.md', '2026-01-01T00:00:00.000Z',
         1, 10, '[]', '{}')
    `);
    await client.execute(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL
      )
    `);
    client.close();

    await runStorage(
      makeConfig(url),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        const document = yield* documents.getDocument("legacy");
        expect(document?.fileType).toBe("markdown");
      }),
    );

    const verification = createClient({ url });
    const documentColumns = await verification.execute(
      "PRAGMA table_info(documents)",
    );
    const chunkColumns = await verification.execute(
      "PRAGMA table_info(chunks)",
    );
    expect(documentColumns.rows.some((row) => row.name === "file_type")).toBe(
      true,
    );
    expect(
      chunkColumns.rows.some((row) => row.name === "embedding_content"),
    ).toBe(true);
    verification.close();
  });

  test("fails startup with a diagnostic for an incompatible schema", async () => {
    const directory = mkdtempSync(join(tmpdir(), "poink-incompatible-"));
    tempDirs.push(directory);
    const url = `file:${join(directory, "library.db")}`;
    const client = createClient({ url });
    await client.execute(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        added_at TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}'
      )
    `);
    client.close();

    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.asVoid(DocumentRepository).pipe(
            Effect.provide(makeStorageLayer(makeConfig(url))),
          ),
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.reason).toContain("table documents");
      expect(result.left.reason).toContain("title");
    }
  });

  test("stores embedding dimension, provider, and model metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "poink-metadata-"));
    tempDirs.push(directory);
    const url = `file:${join(directory, "library.db")}`;
    await runStorage(
      makeConfig(url),
      Effect.gen(function* () {
        const taxonomy = yield* TaxonomyService;
        yield* taxonomy.addConcept({
          id: "concept-1",
          prefLabel: "Concept",
        });
        yield* taxonomy.storeConceptEmbedding("concept-1", [1, 0, 0]);
      }),
    );

    const client = createClient({ url });
    const result = await client.execute(
      "SELECT key, value FROM library_metadata ORDER BY key",
    );
    const metadata = Object.fromEntries(
      result.rows.map((row) => [String(row.key), String(row.value)]),
    );
    expect(metadata).toMatchObject({
      "embedding.dimensions": "3",
      "embedding.provider": "ollama",
      "embedding.model": "mxbai-embed-large",
    });
    client.close();
  });

  test("fails reads with contextual errors for malformed JSON rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "poink-rows-"));
    tempDirs.push(directory);
    const url = `file:${join(directory, "library.db")}`;

    await runStorage(
      makeConfig(url),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        yield* documents.addDocument(makeDocument());
      }),
    );

    const client = createClient({ url });
    await client.execute(
      "UPDATE documents SET tags = '{invalid' WHERE id = 'doc-1'",
    );
    client.close();

    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const documents = yield* DocumentRepository;
            return yield* documents.getDocument("doc-1");
          }).pipe(Effect.provide(makeStorageLayer(makeConfig(url)))),
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(StorageError);
      expect(result.left.reason).toContain("documents.tags");
      expect(result.left.reason).toContain("doc-1");
    }
  });

  test("fails before client creation when authTokenEnv is missing", async () => {
    const variable = "POINK_TEST_MISSING_LIBSQL_TOKEN";
    delete process.env[variable];
    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.asVoid(DocumentRepository).pipe(
            Effect.provide(
              makeStorageLayer(
                makeConfig("libsql://example.invalid", variable),
              ),
            ),
          ),
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.reason).toContain(variable);
    }
  });
});
