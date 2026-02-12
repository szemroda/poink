/**
 * Qdrant Database Service (stub)
 *
 * Placeholder adapter for the upcoming qdrant backend story.
 */

import { Effect, Layer } from "effect";
import { Database } from "./Database.js";
import { DatabaseError } from "../types.js";

type EmbeddingBatch = Array<{ chunkId: string; embedding: number[] }>;

export class QdrantDatabase {
  static make(config: { url: string; collection: string; apiKey?: string }) {
    const reason =
      `Qdrant backend is not implemented yet ` +
      `(url=${config.url}, collection=${config.collection})`;

    const notImplemented = <A = never>() =>
      Effect.fail(new DatabaseError({ reason })) as Effect.Effect<A, DatabaseError>;

    return Layer.succeed(Database, {
      addDocument: () => notImplemented<void>(),
      getDocument: () => notImplemented<null>(),
      getDocumentByPath: () => notImplemented<null>(),
      listDocuments: () => notImplemented<[]>() as Effect.Effect<any, DatabaseError>,
      deleteDocument: () => notImplemented<void>(),
      updateTags: () => notImplemented<void>(),
      addChunks: () => notImplemented<void>(),
      getChunk: () => notImplemented<null>(),
      listChunksByDocument: () =>
        notImplemented<[]>() as Effect.Effect<any, DatabaseError>,
      addEmbeddings: () => notImplemented<void>(),
      replaceDocument: () => notImplemented<void>(),
      vectorSearch: () => notImplemented<[]>() as Effect.Effect<any, DatabaseError>,
      ftsSearch: () => notImplemented<[]>() as Effect.Effect<any, DatabaseError>,
      getExpandedContext: () => notImplemented<any>(),
      getStats: () => notImplemented<any>(),
      countChunksByDocumentIds: () => notImplemented<any>(),
      repair: () => notImplemented<any>(),
      checkpoint: () => notImplemented<void>(),
      dumpDataDir: () => notImplemented<any>(),
      streamEmbeddings: async function* (_batchSize: number): AsyncGenerator<
        EmbeddingBatch,
        void,
        unknown
      > {
        throw new Error(reason);
      },
      bulkInsertClusterAssignments: () => notImplemented<void>(),
    });
  }
}
