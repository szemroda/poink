import { Context, Effect, Either, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  Config,
  Document,
  OllamaError,
  SearchOptions,
  SemanticSearchProviderError,
} from "../types.js";
import {
  DocumentRepository,
  LibraryMaintenance,
  SearchRepository,
  type DocumentRepositoryService,
  type LibraryMaintenanceService,
  type SearchRepositoryService,
} from "./StorageRepositories.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import {
  makeSemanticLibrary,
  SemanticLibrary,
  type SemanticLibraryService,
} from "./SemanticLibrary.js";

type DatabaseService = DocumentRepositoryService &
  SearchRepositoryService &
  LibraryMaintenanceService;
type EmbeddingProviderService = Context.Tag.Service<typeof EmbeddingProvider>;
type EmbeddingRecord = Parameters<DatabaseService["addEmbeddings"]>[0][number];

function makeDatabase(
  overrides: Partial<DatabaseService> = {},
): DatabaseService {
  return {
    addDocument: () => Effect.void,
    getDocument: () => Effect.succeed(null),
    getDocumentByPath: () => Effect.succeed(null),
    listDocuments: () => Effect.succeed([]),
    deleteDocument: () => Effect.void,
    updateTags: () => Effect.void,
    updateDocumentPath: () => Effect.void,
    addChunks: () => Effect.void,
    getChunk: () => Effect.succeed(null),
    listChunksByDocument: () => Effect.succeed([]),
    addEmbeddings: () => Effect.void,
    vectorSearch: () => Effect.succeed([]),
    ftsSearch: () => Effect.succeed([]),
    getExpandedContext: () =>
      Effect.succeed({ content: "", startChunk: "", endChunk: "" }),
    getStats: () =>
      Effect.succeed({ documents: 0, chunks: 0, embeddings: 0 }),
    countChunksByDocumentIds: () => Effect.succeed({}),
    repair: () =>
      Effect.succeed({
        orphanedChunks: 0,
        orphanedEmbeddings: 0,
        zeroVectorEmbeddings: 0,
      }),
    checkpoint: () => Effect.void,
    ...overrides,
  };
}

function makeEmbeddingProvider(
  overrides: Partial<EmbeddingProviderService> = {},
): EmbeddingProviderService {
  return {
    provider: "ollama",
    checkHealth: () => Effect.void,
    embed: () => Effect.succeed([1, 0, 0]),
    embedBatch: (texts) => Effect.succeed(texts.map(() => [1, 0, 0])),
    ...overrides,
  };
}

function runLibrary<A, E>(
  database: DatabaseService,
  embeddingProvider: EmbeddingProviderService,
  use: (library: SemanticLibraryService) => Effect.Effect<A, E>,
): Promise<Either.Either<A, E>> {
  const deps = Layer.mergeAll(
    Layer.succeed(DocumentRepository, database),
    Layer.succeed(SearchRepository, database),
    Layer.succeed(LibraryMaintenance, database),
    Layer.succeed(EmbeddingProvider, embeddingProvider),
  );
  return Effect.runPromise(
    Effect.either(Effect.flatMap(SemanticLibrary, use)).pipe(
      Effect.provide(
        makeSemanticLibrary(Config.Default).pipe(Layer.provide(deps)),
      ),
    ),
  );
}

describe("SemanticLibrary.search", () => {
  const failure = () => Effect.fail(new OllamaError({ reason: "unavailable" }));

  test.each([
    ["provider health", { checkHealth: failure }],
    ["query embedding", { embed: failure }],
  ] as const)(
    "reports %s failure without falling back to FTS",
    async (_stage, providerOverrides) => {
      let ftsCalls = 0;
      const database = makeDatabase({
        ftsSearch: () =>
          Effect.sync(() => {
            ftsCalls++;
            return [];
          }),
      });

      const result = await runLibrary(
        database,
        makeEmbeddingProvider(providerOverrides),
        (library) =>
          library.search("query", new SearchOptions({ hybrid: true })),
      );

      expect(result).toEqual(
        Either.left(
          new SemanticSearchProviderError({
            provider: "ollama",
            reason: "unavailable",
          }),
        ),
      );
      expect(ftsCalls).toBe(0);
    },
  );
});

describe("SemanticLibrary.reindexEmbeddings", () => {
  test("embeds stored embedding content, rebuilding it only when missing", async () => {
    const embeddedTexts: string[][] = [];
    const storedEmbeddings: EmbeddingRecord[][] = [];
    const doc = new Document({
      id: "doc-1",
      title: "Doc",
      path: "doc.md",
      addedAt: new Date(),
      pageCount: 1,
      sizeBytes: 10,
      tags: [],
      fileType: "markdown",
      metadata: {},
    });
    const database = makeDatabase({
      getDocument: () => Effect.succeed(doc),
      listChunksByDocument: () =>
        Effect.succeed([
          {
            id: "chunk-1",
            docId: "doc-1",
            page: 1,
            chunkIndex: 0,
            content: "Display text",
            embeddingContent: "Stored embedding text",
          },
          {
            id: "chunk-2",
            docId: "doc-1",
            page: 2,
            chunkIndex: 1,
            content: "Legacy text",
          },
        ]),
      addEmbeddings: (items) =>
        Effect.sync(() => {
          storedEmbeddings.push(items);
        }),
    });
    const embeddingProvider = makeEmbeddingProvider({
      embedBatch: (texts) =>
        Effect.sync(() => {
          embeddedTexts.push(texts);
          return texts.map(() => [1, 0, 0]);
        }),
    });

    const result = await runLibrary(database, embeddingProvider, (library) =>
      library.reindexEmbeddings("doc-1"),
    );

    expect(Either.getOrThrow(result)).toEqual({
      docId: "doc-1",
      title: "Doc",
      chunks: 2,
      embeddings: 2,
    });
    expect(embeddedTexts).toEqual([
      ["Stored embedding text", "Document: Doc\nPage: 2\n\nLegacy text"],
    ]);
    expect(storedEmbeddings).toEqual([
      [
        { chunkId: "chunk-1", embedding: [1, 0, 0] },
        { chunkId: "chunk-2", embedding: [1, 0, 0] },
      ],
    ]);
  });
});
