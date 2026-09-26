import { createClient, type ResultSet } from "@libsql/client";
import { Effect, Either } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Config, Document, SearchOptions } from "../types.js";
import { removeDirWithRetries } from "../testUtils.js";
import {
  DocumentIntegrityRepository,
  DocumentRepository,
  LibraryMaintenance,
  SearchRepository,
  StorageError,
  VectorRebuildRepository,
  type ChunkInput,
  type VectorStagingService,
} from "./StorageRepositories.js";
import { makeStorageLayer } from "./StorageLayer.js";
import { TaxonomyService } from "./TaxonomyService.js";
import {
  classifyLibsqlUrl,
  createVectorSchemaManager,
  initializeLibSQLSchema,
} from "./LibSQLSchema.js";

// One root for the whole suite: Windows releases libSQL file handles lazily,
// so per-test removal spends seconds retrying on EBUSY.
const tempRoot = mkdtempSync(join(tmpdir(), "poink-libsql-"));
let databaseCount = 0;

afterAll(() => removeDirWithRetries(tempRoot), 60_000);

/** Returns a `file:` URL for a fresh database under the suite temp root. */
function fileDatabaseUrl(): string {
  return `file:${join(tempRoot, `library-${databaseCount++}.db`)}`;
}

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

function makeChunk(
  id: string,
  content: string,
  overrides: Partial<ChunkInput> = {},
): ChunkInput {
  return { id, docId: "doc-1", page: 1, chunkIndex: 0, content, ...overrides };
}

const TEST_SOURCE_IDENTITY = {
  algorithm: "sha256" as const,
  hash: "a".repeat(64),
};

type StorageServices =
  | DocumentRepository
  | DocumentIntegrityRepository
  | SearchRepository
  | LibraryMaintenance
  | VectorRebuildRepository
  | TaxonomyService;

function runStorageEither<A, E>(
  config: Config,
  effect: Effect.Effect<A, E, StorageServices>,
) {
  return Effect.runPromise(
    Effect.either(
      Effect.scoped(effect.pipe(Effect.provide(makeStorageLayer(config)))),
    ),
  );
}

async function runStorage<A, E>(
  config: Config,
  effect: Effect.Effect<A, E, StorageServices>,
): Promise<A> {
  return Either.getOrThrow(await runStorageEither(config, effect));
}

/** Runs raw SQL against a database file outside the storage layer. */
async function withClient<A>(
  url: string,
  use: (execute: (sql: string) => Promise<ResultSet>) => Promise<A>,
): Promise<A> {
  const client = createClient({ url });
  try {
    return await use((sql) => client.execute(sql));
  } finally {
    client.close();
  }
}

const sourceIdentityOf = (id: string) =>
  Effect.flatMap(DocumentIntegrityRepository, (integrity) =>
    integrity.getDocumentWithSourceIdentity(id),
  ).pipe(Effect.map((stored) => stored?.sourceIdentity));

describe("libSQL storage", () => {
  test.each([
    [":memory:", "memory"],
    ["file::memory:?cache=shared", "memory"],
    ["file:./library.db", "local"],
    ["libsql://example.turso.io", "remote"],
    ["https://example.turso.io", "remote"],
  ] as const)("classifies %s as %s", (url, mode) => {
    expect(classifyLibsqlUrl(url)).toBe(mode);
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
        const integrity = yield* DocumentIntegrityRepository;
        const maintenance = yield* LibraryMaintenance;
        const doc = makeDocument();

        yield* integrity.replaceDocument(
          doc,
          [makeChunk("chunk-1", "first content")],
          [{ chunkId: "chunk-1", embedding: [1, 0, 0] }],
          TEST_SOURCE_IDENTITY,
          "add",
        );
        const updated = new Document({
          ...doc,
          title: "Stale title",
          tags: ["stale"],
          metadata: {
            source: "stale",
            chunker: { id: "new", version: 2 },
            visuals: { enabled: true, version: 1 },
          },
          fileType: "docx",
        });
        yield* integrity.replaceDocument(
          updated,
          [makeChunk("chunk-2", "second content")],
          [{ chunkId: "chunk-2", embedding: [0, 1, 0] }],
          TEST_SOURCE_IDENTITY,
          "refresh",
        );

        // Refresh keeps user-owned fields and replaces source-derived ones.
        expect(yield* documents.getDocument(doc.id)).toMatchObject({
          title: "Document",
          tags: ["test"],
          fileType: "docx",
          metadata: {
            source: "test",
            chunker: { id: "new", version: 2 },
            visuals: { enabled: true, version: 1 },
          },
        });
        expect(yield* sourceIdentityOf(doc.id)).toEqual({
          status: "valid",
          identity: TEST_SOURCE_IDENTITY,
        });
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
        const integrity = yield* DocumentIntegrityRepository;
        const doc = makeDocument();
        const result = yield* Effect.either(
          integrity.replaceDocument(
            doc,
            [makeChunk("chunk-1", "content")],
            [{ chunkId: "missing-chunk", embedding: [1, 0, 0] }],
            TEST_SOURCE_IDENTITY,
            "add",
          ),
        );

        expect(Either.isLeft(result)).toBe(true);
        expect(yield* documents.getDocument(doc.id)).toBeNull();
        expect(yield* documents.listChunksByDocument(doc.id)).toEqual([]);
      }),
    );
  });

  test("preserves all stored source-derived state when refresh fails", async () => {
    await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        const integrity = yield* DocumentIntegrityRepository;
        const doc = makeDocument();
        const oldChunk = makeChunk("old-chunk", "old content", {
          page: 2,
          embeddingContent: "old embedding content",
        });
        yield* integrity.replaceDocument(
          doc,
          [oldChunk],
          [{ chunkId: "old-chunk", embedding: [1, 0, 0] }],
          TEST_SOURCE_IDENTITY,
          "add",
        );

        const attempted = new Document({
          ...doc,
          pageCount: 7,
          sizeBytes: 999,
          fileType: "docx",
          metadata: {
            ...doc.metadata,
            chunker: { id: "new", version: 99 },
            visuals: { enabled: true, version: 1 },
          },
        });
        const result = yield* Effect.either(
          integrity.replaceDocument(
            attempted,
            [makeChunk("new-chunk", "new content")],
            [{ chunkId: "missing-new-chunk", embedding: [0, 1, 0] }],
            { algorithm: "sha256", hash: "b".repeat(64) },
            "refresh",
          ),
        );

        expect(Either.isLeft(result)).toBe(true);
        expect(yield* documents.getDocument(doc.id)).toEqual(doc);
        expect(yield* documents.listChunksByDocument(doc.id)).toEqual([
          expect.objectContaining(oldChunk),
        ]);
        expect(yield* sourceIdentityOf(doc.id)).toEqual({
          status: "valid",
          identity: TEST_SOURCE_IDENTITY,
        });
      }),
    );
  });

  test("rejects malformed source identity writes before persistence", async () => {
    await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        const integrity = yield* DocumentIntegrityRepository;
        const doc = makeDocument();
        const result = yield* Effect.either(
          integrity.replaceDocument(
            doc,
            [],
            [],
            { algorithm: "sha256", hash: "g".repeat(64) },
            "add",
          ),
        );

        expect(Either.isLeft(result)).toBe(true);
        expect(yield* documents.getDocument(doc.id)).toBeNull();
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

  test("finds a stored chunk through vector and FTS search", async () => {
    await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const integrity = yield* DocumentIntegrityRepository;
        const search = yield* SearchRepository;
        yield* integrity.replaceDocument(
          makeDocument(),
          [makeChunk("chunk-1", "semantic storage architecture")],
          [{ chunkId: "chunk-1", embedding: [1, 0, 0] }],
          TEST_SOURCE_IDENTITY,
          "add",
        );
        const options = new SearchOptions({ limit: 5 });

        expect(yield* search.vectorSearch([1, 0, 0], options)).toEqual([
          expect.objectContaining({
            chunkId: "chunk-1",
            scoreType: "cosine_similarity",
          }),
        ]);
        expect(yield* search.ftsSearch("storage", options)).toEqual([
          expect.objectContaining({
            chunkId: "chunk-1",
            scoreType: "fts_rank",
          }),
        ]);
      }),
    );
  });

  test("expands context in document order across page boundaries", async () => {
    await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        const search = yield* SearchRepository;
        yield* documents.addDocument(makeDocument());
        yield* documents.addDocument(makeDocument("other"));
        yield* documents.addChunks([
          makeChunk("e", "E", { page: 3 }),
          makeChunk("b", "B", { chunkIndex: 1 }),
          makeChunk("c", "C", { page: 2 }),
          makeChunk("a", "A"),
          makeChunk("d", "D", { page: 2, chunkIndex: 1 }),
          makeChunk("other", "Other", { docId: "other", page: 2 }),
        ]);

        for (const [direction, content, startChunk, endChunk] of [
          ["before", "A\nB\nC", "p1c0", "p2c0"],
          ["after", "C\nD\nE", "p2c0", "p3c0"],
          ["both", "A\nB\nC\nD\nE", "p1c0", "p3c0"],
        ] as const) {
          expect(yield* search.getExpandedContext("doc-1", 2, 0, {
            direction,
            maxChars: 100,
          })).toEqual({ content, startChunk, endChunk });
        }
        expect(yield* search.getExpandedContext("doc-1", 2, 0, {
          maxChars: 1,
        })).toEqual({ content: "C", startChunk: "p2c0", endChunk: "p2c0" });
      }),
    );
  });

  test("upgrades supported legacy columns during centralized startup", async () => {
    const url = fileDatabaseUrl();
    await withClient(url, async (execute) => {
      await execute(`
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
      await execute(`
        INSERT INTO documents
          (id, title, path, added_at, page_count, size_bytes, tags, metadata)
        VALUES
          ('legacy', 'Legacy', '/legacy.md', '2026-01-01T00:00:00.000Z',
           1, 10, '[]', '{}')
      `);
      await execute(`
        CREATE TABLE chunks (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          page INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL
        )
      `);
      await execute("CREATE INDEX idx_chunks_doc ON chunks(doc_id)");
    });

    await runStorage(
      makeConfig(url),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        expect((yield* documents.getDocument("legacy"))?.fileType).toBe(
          "markdown",
        );
        expect(yield* sourceIdentityOf("legacy")).toEqual({
          status: "missing",
        });
      }),
    );

    await withClient(url, async (execute) => {
      const names = async (sql: string) =>
        (await execute(sql)).rows.map((row) => row.name);

      expect(
        await names("PRAGMA index_info(idx_chunks_doc_position)"),
      ).toEqual(["doc_id", "page", "chunk_index"]);
      expect(await names("PRAGMA index_list(chunks)")).not.toContain(
        "idx_chunks_doc",
      );
      expect(await names("PRAGMA table_info(documents)")).toEqual(
        expect.arrayContaining([
          "file_type",
          "source_hash_algorithm",
          "source_hash",
        ]),
      );
      expect(await names("PRAGMA table_info(chunks)")).toContain(
        "embedding_content",
      );
    });
  });

  test("isolates malformed source identity from ordinary document reads", async () => {
    const url = fileDatabaseUrl();
    await runStorage(
      makeConfig(url),
      Effect.flatMap(DocumentRepository, (documents) =>
        documents.addDocument(makeDocument()),
      ),
    );
    await withClient(url, (execute) =>
      execute(
        `UPDATE documents
         SET source_hash_algorithm = 'sha256', source_hash = '${"g".repeat(64)}'
         WHERE id = 'doc-1'`,
      ),
    );

    await runStorage(
      makeConfig(url),
      Effect.gen(function* () {
        const documents = yield* DocumentRepository;
        expect((yield* documents.getDocument("doc-1"))?.id).toBe("doc-1");
        expect(yield* sourceIdentityOf("doc-1")).toEqual({
          status: "invalid",
        });
      }),
    );
  });

  test.each([
    ["half-null", "source_hash = NULL"],
    ["uppercase", `source_hash = '${"A".repeat(64)}'`],
  ])("fresh schema rejects %s identities", async (_case, hashAssignment) => {
    const client = createClient({ url: ":memory:" });
    try {
      await initializeLibSQLSchema(client, "memory");
      await client.execute(`
        INSERT INTO documents
          (id, title, path, added_at, page_count, size_bytes, tags,
           file_type, metadata)
        VALUES
          ('doc-1', 'Document', '/doc.md', '2026-01-01T00:00:00.000Z',
           1, 10, '[]', 'markdown', '{}')
      `);

      await expect(
        client.execute(
          `UPDATE documents
           SET source_hash_algorithm = 'sha256', ${hashAssignment}
           WHERE id = 'doc-1'`,
        ),
      ).rejects.toThrow();
    } finally {
      client.close();
    }
  });

  test("fails startup with a diagnostic for an incompatible schema", async () => {
    const url = fileDatabaseUrl();
    await withClient(url, (execute) =>
      execute(`
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          added_at TEXT NOT NULL,
          page_count INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          tags TEXT DEFAULT '[]',
          metadata TEXT DEFAULT '{}'
        )
      `),
    );

    const result = await runStorageEither(
      makeConfig(url),
      Effect.asVoid(DocumentRepository),
    );

    const { reason } = Either.getOrThrow(Either.flip(result));
    expect(reason).toContain("table documents");
    expect(reason).toContain("title");
  });

  test("stores embedding dimension, provider, and model metadata", async () => {
    const url = fileDatabaseUrl();
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

    const result = await withClient(url, (execute) =>
      execute("SELECT key, value FROM library_metadata"),
    );
    expect(
      Object.fromEntries(
        result.rows.map((row) => [String(row.key), String(row.value)]),
      ),
    ).toMatchObject({
      "embedding.dimensions": "3",
      "embedding.provider": "ollama",
      "embedding.model": "mxbai-embed-large",
    });
  });

  describe("embedding model identity", () => {
    const withEmbeddingModel = (url: string, model: string) =>
      new Config({
        ...makeConfig(url),
        models: {
          ...Config.Default.models,
          embedding: { ...Config.Default.models.embedding, model },
        },
      });
    const addDocument = (id: string) =>
      Effect.flatMap(DocumentIntegrityRepository, (integrity) =>
        integrity.replaceDocument(
          makeDocument(id),
          [makeChunk(`${id}-chunk`, "content", { docId: id })],
          [{ chunkId: `${id}-chunk`, embedding: [1, 0, 0] }],
          TEST_SOURCE_IDENTITY,
          "add",
        ),
      );
    const search = Effect.flatMap(SearchRepository, (repository) =>
      repository.vectorSearch([1, 0, 0]),
    );
    const readIdentity = (url: string) =>
      withClient(url, async (execute) => {
        const result = await execute(
          "SELECT key, value FROM library_metadata WHERE key LIKE 'embedding.%'",
        );
        return Object.fromEntries(
          result.rows.map((row) => [String(row.key), String(row.value)]),
        );
      });

    test("rejects writes and queries from a different model with equal dimensions", async () => {
      const url = fileDatabaseUrl();
      await runStorage(withEmbeddingModel(url, "model-a"), addDocument("doc-1"));

      const other = withEmbeddingModel(url, "model-b");
      for (const effect of [search, addDocument("doc-2")]) {
        const result = await runStorageEither(other, effect);
        expect(result).toEqual(
          Either.left(
            expect.objectContaining({
              reason: expect.stringContaining("model-a"),
            }),
          ),
        );
      }
      expect(await readIdentity(url)).toMatchObject({
        "embedding.model": "model-a",
      });
      expect(
        await runStorage(withEmbeddingModel(url, "model-a"), search),
      ).toHaveLength(1);
    });

    test("records the writing model's identity for libraries created without one", async () => {
      const url = fileDatabaseUrl();
      await runStorage(withEmbeddingModel(url, "model-a"), addDocument("doc-1"));
      await withClient(url, (execute) =>
        execute(
          "DELETE FROM library_metadata WHERE key IN ('embedding.provider', 'embedding.model')",
        ),
      );

      await runStorage(withEmbeddingModel(url, "model-b"), search);
      expect(await readIdentity(url)).not.toHaveProperty("embedding.model");

      await runStorage(withEmbeddingModel(url, "model-b"), addDocument("doc-2"));
      expect(await readIdentity(url)).toMatchObject({
        "embedding.provider": Config.Default.models.embedding.provider,
        "embedding.model": "model-b",
      });
    });

    const rebuild = <A, E>(
      dimension: number,
      stage: (staging: VectorStagingService) => Effect.Effect<A, E>,
    ) =>
      Effect.flatMap(VectorRebuildRepository, (repository) =>
        repository.rebuildVectors(dimension, stage),
      );
    const readStagingTables = (url: string) =>
      withClient(url, async (execute) =>
        (
          await execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%rebuild%'",
          )
        ).rows.map((row) => String(row.name)),
      );

    test("rebuilds every vector collection for a new model and dimension", async () => {
      const url = fileDatabaseUrl();
      await runStorage(
        withEmbeddingModel(url, "model-a"),
        Effect.gen(function* () {
          yield* addDocument("doc-1");
          const taxonomy = yield* TaxonomyService;
          yield* taxonomy.addConcept({ id: "concept-1", prefLabel: "Concept" });
          yield* taxonomy.addConcept({ id: "concept-2", prefLabel: "No vector" });
          yield* taxonomy.storeConceptEmbedding("concept-1", [1, 0, 0]);
        }),
      );
      await withClient(url, (execute) =>
        execute(
          `INSERT INTO cluster_summaries (id, centroid, summary, embedding, chunk_count)
           VALUES (1, vector32('[1, 0, 0]'), 'Summary', vector32('[1, 0, 0]'), 1)`,
        ),
      );

      const modelB = withEmbeddingModel(url, "model-b");
      const vector = [0, 0, 0, 1];
      const sources = await runStorage(
        modelB,
        rebuild(4, (staging) =>
          Effect.gen(function* () {
            yield* staging.stageChunkEmbeddings([
              { chunkId: "doc-1-chunk", embedding: vector },
            ]);
            yield* staging.stageConceptEmbeddings([
              { conceptId: "concept-1", embedding: vector },
            ]);
            yield* staging.stageClusterSummaryEmbeddings([
              { id: 1, embedding: vector },
            ]);
            return {
              concepts: yield* staging.listEmbeddedConcepts(),
              clusterSummaries: yield* staging.listClusterSummaries(),
            };
          }),
        ),
      );

      expect(sources).toEqual({
        concepts: [{ id: "concept-1", prefLabel: "Concept" }],
        clusterSummaries: [{ id: 1, summary: "Summary" }],
      });
      expect(await readIdentity(url)).toEqual({
        "embedding.dimensions": "4",
        "embedding.provider": Config.Default.models.embedding.provider,
        "embedding.model": "model-b",
      });
      const found = await runStorage(
        modelB,
        Effect.gen(function* () {
          const search = yield* SearchRepository;
          const taxonomy = yield* TaxonomyService;
          return {
            hits: yield* search.vectorSearch(
              vector,
              new SearchOptions({ includeClusterSummaries: true }),
            ),
            concepts: yield* taxonomy.findSimilarConcepts(vector, 0.9),
          };
        }),
      );
      expect(found.hits.map((hit) => hit.chunkId).sort()).toEqual([
        "cluster-summary-1",
        "doc-1-chunk",
      ]);
      expect(found.concepts.map((concept) => concept.id)).toEqual(["concept-1"]);
      const centroid = await withClient(url, (execute) =>
        execute("SELECT centroid FROM cluster_summaries"),
      );
      expect(centroid.rows[0]?.centroid).toBeNull();
      expect(await readStagingTables(url)).toEqual([]);
    });

    test("lets only the most recently started rebuild commit or clean up", async () => {
      const client = createClient({ url: ":memory:" });
      try {
        await initializeLibSQLSchema(client, "memory");
        const vectors = createVectorSchemaManager(client, {
          provider: "ollama",
          model: "model-b",
        });
        const staged = () =>
          client
            .execute(
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%rebuild'",
            )
            .then((result) => Number(result.rows[0]?.n));

        const first = await vectors.createStaging(4);
        const second = await vectors.createStaging(4);

        await expect(vectors.commitStaging(4, first)).rejects.toThrow(
          "newer rebuild",
        );
        await vectors.dropStaging(first);
        expect(await staged()).toBe(3);
        await vectors.commitStaging(4, second);
        expect(await staged()).toBe(0);
      } finally {
        client.close();
      }
    });

    test("does not resurrect a chunk deleted after its vector was staged", async () => {
      const url = fileDatabaseUrl();
      await runStorage(
        withEmbeddingModel(url, "model-a"),
        Effect.all([addDocument("doc-1"), addDocument("doc-2")]),
      );

      await runStorage(
        withEmbeddingModel(url, "model-b"),
        Effect.flatMap(DocumentRepository, (documents) =>
          rebuild(4, (staging) =>
            Effect.gen(function* () {
              yield* staging.stageChunkEmbeddings(
                ["doc-1-chunk", "doc-2-chunk"].map((chunkId) => ({
                  chunkId,
                  embedding: [0, 0, 0, 1],
                })),
              );
              yield* documents.deleteDocument("doc-2");
            }),
          ),
        ),
      );

      const vectors = await withClient(url, (execute) =>
        execute("SELECT chunk_id FROM embeddings"),
      );
      expect(vectors.rows.map((row) => row.chunk_id)).toEqual(["doc-1-chunk"]);
    });

    test.each<[string, (staging: VectorStagingService) => Effect.Effect<void, unknown>]>([
      ["staging fails", () => Effect.fail("embedding failed")],
      [
        "a live chunk has no rebuilt vector",
        (staging) =>
          staging.stageConceptEmbeddings([
            { conceptId: "concept-1", embedding: [0, 0, 0, 1] },
          ]),
      ],
      [
        "a live concept vector has no rebuilt vector",
        (staging) =>
          staging.stageChunkEmbeddings([
            { chunkId: "doc-1-chunk", embedding: [0, 0, 0, 1] },
          ]),
      ],
      [
        "a vector has the wrong dimension",
        (staging) =>
          staging.stageChunkEmbeddings([
            { chunkId: "doc-1-chunk", embedding: [0, 0, 1] },
          ]),
      ],
    ])("keeps the live library when %s", async (_name, stage) => {
      const url = fileDatabaseUrl();
      await runStorage(
        withEmbeddingModel(url, "model-a"),
        Effect.gen(function* () {
          yield* addDocument("doc-1");
          const taxonomy = yield* TaxonomyService;
          yield* taxonomy.addConcept({ id: "concept-1", prefLabel: "Concept" });
          yield* taxonomy.storeConceptEmbedding("concept-1", [1, 0, 0]);
        }),
      );

      const result = await runStorageEither(
        withEmbeddingModel(url, "model-b"),
        rebuild(4, stage),
      );

      expect(Either.isLeft(result)).toBe(true);
      expect(await readIdentity(url)).toMatchObject({
        "embedding.dimensions": "3",
        "embedding.model": "model-a",
      });
      expect(
        await runStorage(withEmbeddingModel(url, "model-a"), search),
      ).toHaveLength(1);
      expect(await readStagingTables(url)).toEqual([]);
    });
  });

  test("finds tagged vector matches ranked behind closer untagged chunks", async () => {
    const results = await runStorage(
      makeConfig(),
      Effect.gen(function* () {
        const integrity = yield* DocumentIntegrityRepository;
        const search = yield* SearchRepository;
        const add = (id: string, tags: string[], embedding: number[]) =>
          integrity.replaceDocument(
            new Document({ ...makeDocument(id), tags }),
            [makeChunk(`${id}-chunk`, id, { docId: id })],
            [{ chunkId: `${id}-chunk`, embedding }],
            TEST_SOURCE_IDENTITY,
            "add",
          );
        for (let index = 0; index < 5; index++) {
          yield* add(`near-${index}`, ["other"], [1, index / 100, 0]);
        }
        yield* add("wanted", ["wanted"], [0, 1, 0]);

        return yield* search.vectorSearch(
          [1, 0, 0],
          new SearchOptions({ limit: 1, tags: ["wanted"] }),
        );
      }),
    );

    expect(results.map((result) => result.docId)).toEqual(["wanted"]);
  });

  test("fails reads with contextual errors for malformed JSON rows", async () => {
    const url = fileDatabaseUrl();
    await runStorage(
      makeConfig(url),
      Effect.flatMap(DocumentRepository, (documents) =>
        documents.addDocument(makeDocument()),
      ),
    );
    await withClient(url, (execute) =>
      execute("UPDATE documents SET tags = '{invalid' WHERE id = 'doc-1'"),
    );

    const result = await runStorageEither(
      makeConfig(url),
      Effect.flatMap(DocumentRepository, (documents) =>
        documents.getDocument("doc-1"),
      ),
    );

    const error = Either.getOrThrow(Either.flip(result));
    expect(error).toBeInstanceOf(StorageError);
    expect(error.reason).toContain("documents.tags");
    expect(error.reason).toContain("doc-1");
  });

  test("fails before client creation when authTokenEnv is missing", async () => {
    const variable = "POINK_TEST_MISSING_LIBSQL_TOKEN";
    delete process.env[variable];

    const result = await runStorageEither(
      makeConfig("libsql://example.invalid", variable),
      Effect.asVoid(DocumentRepository),
    );

    expect(Either.getOrThrow(Either.flip(result)).reason).toContain(variable);
  });
});
