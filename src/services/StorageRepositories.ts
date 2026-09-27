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
  readonly updateDocumentPath: (
    id: string,
    path: string,
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
  /**
   * Returns the target chunk's text joined with neighboring chunks, up to about
   * `maxChars`, or null when the target chunk does not exist.
   */
  readonly getExpandedContext: (
    docId: string,
    page: number,
    chunkIndex: number,
    maxChars: number,
  ) => Effect.Effect<string | null, StorageError>;
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
    { orphanedChunks: number; orphanedEmbeddings: number },
    StorageError
  >;
  readonly checkpoint: () => Effect.Effect<void, StorageError>;
}

export class LibraryMaintenance extends Context.Tag("LibraryMaintenance")<
  LibraryMaintenance,
  LibraryMaintenanceService
>() {}

/** The text fields a concept vector is embedded from. */
export type ConceptEmbeddingSource = {
  id: string;
  prefLabel: string;
  definition?: string;
};

/**
 * Writes regenerated vectors next to the live ones during a rebuild. Every
 * vector must have the rebuild's dimension.
 */
export interface VectorStagingService {
  /** Concepts that have a vector in the live library. */
  readonly listEmbeddedConcepts: () => Effect.Effect<
    ConceptEmbeddingSource[],
    StorageError
  >;
  readonly stageChunkEmbeddings: (
    items: readonly EmbeddingInput[],
  ) => Effect.Effect<void, StorageError>;
  readonly stageConceptEmbeddings: (
    items: ReadonlyArray<{ conceptId: string; embedding: number[] }>,
  ) => Effect.Effect<void, StorageError>;
}

export interface VectorRebuildRepositoryService {
  /**
   * Runs `stage` to regenerate every vector at `dimension`, then swaps all
   * vector collections in one transaction and records the configured
   * embedding model. The live library is unchanged if staging fails or if
   * any live chunk or concept vector was left unstaged.
   */
  readonly rebuildVectors: <A, E, R>(
    dimension: number,
    stage: (staging: VectorStagingService) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageError, R>;
}

export class VectorRebuildRepository extends Context.Tag(
  "VectorRebuildRepository",
)<VectorRebuildRepository, VectorRebuildRepositoryService>() {}
