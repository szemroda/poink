import { Context, Effect, Schema } from "effect";
import type {
  Document,
  DocumentSearchResult,
  PDFChunk,
  SearchOptions,
} from "../types.js";
import type {
  SourceIdentity,
  StoredSourceIdentity,
} from "./SourceIntegrity.js";

export class StorageError extends Schema.TaggedError<StorageError>()(
  "StorageError",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {}

export function storageEffect<A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, StorageError> {
  return Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof StorageError
        ? error
        : new StorageError({
            operation,
            reason: error instanceof Error ? error.message : String(error),
          }),
  });
}

export type ChunkInput = {
  id: string;
  docId: string;
  page: number;
  chunkIndex: number;
  content: string;
  embeddingContent?: string;
};

export type EmbeddingInput = {
  chunkId: string;
  embedding: number[];
};

export type DocumentWithSourceIdentity = {
  document: Document;
  sourceIdentity: StoredSourceIdentity;
};

export interface DocumentRepositoryService {
  readonly addDocument: (
    doc: Document,
  ) => Effect.Effect<void, StorageError>;
  readonly getDocument: (
    id: string,
  ) => Effect.Effect<Document | null, StorageError>;
  readonly getDocumentByPath: (
    path: string,
  ) => Effect.Effect<Document | null, StorageError>;
  readonly listDocuments: (
    tag?: string,
  ) => Effect.Effect<Document[], StorageError>;
  readonly deleteDocument: (
    id: string,
  ) => Effect.Effect<void, StorageError>;
  readonly updateTags: (
    id: string,
    tags: string[],
  ) => Effect.Effect<void, StorageError>;
  readonly addChunks: (
    chunks: ChunkInput[],
  ) => Effect.Effect<void, StorageError>;
  readonly getChunk: (
    chunkId: string,
  ) => Effect.Effect<PDFChunk | null, StorageError>;
  readonly listChunksByDocument: (
    docId: string,
    options?: { page?: number },
  ) => Effect.Effect<PDFChunk[], StorageError>;
  readonly addEmbeddings: (
    embeddings: EmbeddingInput[],
  ) => Effect.Effect<void, StorageError>;
}

export interface DocumentIntegrityRepositoryService {
  readonly replaceDocument: (
    doc: Document,
    chunks: ChunkInput[],
    embeddings: EmbeddingInput[],
    sourceIdentity: SourceIdentity,
    mode: "add" | "refresh",
  ) => Effect.Effect<void, StorageError>;
  readonly getDocumentWithSourceIdentity: (
    id: string,
  ) => Effect.Effect<DocumentWithSourceIdentity | null, StorageError>;
  readonly listDocumentsWithSourceIdentity: (
    tag?: string,
  ) => Effect.Effect<DocumentWithSourceIdentity[], StorageError>;
}

export class DocumentRepository extends Context.Tag("DocumentRepository")<
  DocumentRepository,
  DocumentRepositoryService
>() {}

export class DocumentIntegrityRepository extends Context.Tag(
  "DocumentIntegrityRepository",
)<
  DocumentIntegrityRepository,
  DocumentIntegrityRepositoryService
>() {}

export interface SearchRepositoryService {
  readonly vectorSearch: (
    embedding: number[],
    options?: SearchOptions,
  ) => Effect.Effect<DocumentSearchResult[], StorageError>;
  readonly ftsSearch: (
    query: string,
    options?: SearchOptions,
  ) => Effect.Effect<DocumentSearchResult[], StorageError>;
  readonly getExpandedContext: (
    docId: string,
    page: number,
    chunkIndex: number,
    options?: {
      maxChars?: number;
      direction?: "before" | "after" | "both";
    },
  ) => Effect.Effect<
    { content: string; startChunk: string; endChunk: string },
    StorageError
  >;
}

export class SearchRepository extends Context.Tag("SearchRepository")<
  SearchRepository,
  SearchRepositoryService
>() {}

export interface LibraryMaintenanceService {
  readonly getStats: () => Effect.Effect<
    { documents: number; chunks: number; embeddings: number },
    StorageError
  >;
  readonly countChunksByDocumentIds: (
    docIds: string[],
  ) => Effect.Effect<Record<string, number>, StorageError>;
  readonly repair: () => Effect.Effect<
    {
      orphanedChunks: number;
      orphanedEmbeddings: number;
      zeroVectorEmbeddings: number;
    },
    StorageError
  >;
  readonly checkpoint: () => Effect.Effect<void, StorageError>;
}

export class LibraryMaintenance extends Context.Tag("LibraryMaintenance")<
  LibraryMaintenance,
  LibraryMaintenanceService
>() {}
