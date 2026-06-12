import { Context, Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";
import {
  Config,
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
} from "./SemanticLibrary.js";

type DatabaseService = DocumentRepositoryService &
  SearchRepositoryService &
  LibraryMaintenanceService;
type EmbeddingProviderService = Context.Tag.Service<typeof EmbeddingProvider>;

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
    addChunks: () => Effect.void,
    getChunk: () => Effect.succeed(null),
    listChunksByDocument: () => Effect.succeed([]),
    addEmbeddings: () => Effect.void,
    replaceDocument: () => Effect.void,
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

function runSearch(
  database: DatabaseService,
  embeddingProvider: EmbeddingProviderService,
) {
  const deps = Layer.mergeAll(
    Layer.succeed(DocumentRepository, database),
    Layer.succeed(SearchRepository, database),
    Layer.succeed(LibraryMaintenance, database),
    Layer.succeed(EmbeddingProvider, embeddingProvider),
  );
  const program = Effect.gen(function* () {
    const library = yield* SemanticLibrary;
    return yield* library.search(
      "query",
      new SearchOptions({ hybrid: true }),
    );
  });
  return Effect.runPromise(
    Effect.either(program).pipe(
      Effect.provide(
        makeSemanticLibrary(Config.Default).pipe(Layer.provide(deps)),
      ),
    ),
  );
}

describe("SemanticLibrary.search", () => {
  test("reports provider health failure without falling back to FTS", async () => {
    let ftsCalls = 0;
    const result = await runSearch(
      makeDatabase({
        ftsSearch: () =>
          Effect.sync(() => {
            ftsCalls++;
            return [];
          }),
      }),
      {
        provider: "ollama",
        checkHealth: () =>
          Effect.fail(new OllamaError({ reason: "provider unavailable" })),
        embed: () => Effect.succeed([1, 0, 0]),
        embedBatch: () => Effect.succeed([]),
      },
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toEqual(
        new SemanticSearchProviderError({
          provider: "ollama",
          reason: "provider unavailable",
        }),
      );
    }
    expect(ftsCalls).toBe(0);
  });

  test("reports query embedding failure without falling back to FTS", async () => {
    let ftsCalls = 0;
    const result = await runSearch(
      makeDatabase({
        ftsSearch: () =>
          Effect.sync(() => {
            ftsCalls++;
            return [];
          }),
      }),
      {
        provider: "ollama",
        checkHealth: () => Effect.void,
        embed: () =>
          Effect.fail(new OllamaError({ reason: "embedding failed" })),
        embedBatch: () => Effect.succeed([]),
      },
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toEqual(
        new SemanticSearchProviderError({
          provider: "ollama",
          reason: "embedding failed",
        }),
      );
    }
    expect(ftsCalls).toBe(0);
  });
});
