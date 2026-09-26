import { Context, Duration, Effect, Layer } from "effect";
import {
  type Config,
  DocumentSearchResult,
  DocumentNotFoundError,
  SemanticSearchProviderError,
  SearchOptions,
  type Document,
  type PDFChunk,
} from "../types.js";
import {
  DocumentRepository,
  LibraryMaintenance,
  SearchRepository,
  VectorRebuildRepository,
} from "./StorageRepositories.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import { DEFAULT_QUEUE_CONFIG } from "./EmbeddingQueue.js";
import {
  buildEmbeddingContent,
  conceptEmbeddingText,
} from "../embeddingContent.js";
import { expandSearchResults } from "./SearchExpansion.js";

type EmbeddingRecord = {
  chunkId: string;
  embedding: number[];
};

/** Embedded once to learn the configured model's vector dimension. */
const DIMENSION_PROBE = "dimension probe";

function providerFailureReason(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "string"
  ) {
    return error.reason;
  }
  return error instanceof Error ? error.message : String(error);
}

function mergeHybridResults(
  vectorResults: readonly DocumentSearchResult[],
  ftsResults: readonly DocumentSearchResult[],
): DocumentSearchResult[] {
  const results = [...vectorResults];
  for (const fts of ftsResults) {
    const existingIndex = results.findIndex(
      (result) =>
        result.docId === fts.docId &&
        result.page === fts.page &&
        result.chunkIndex === fts.chunkIndex,
    );
    if (existingIndex < 0) {
      results.push(fts);
      continue;
    }

    const existing = results[existingIndex]!;
    const vectorScore = existing.vectorScore ?? existing.score;
    const combined = Math.min(
      1,
      Math.max(vectorScore, fts.score) * 1.05,
    );
    results[existingIndex] = new DocumentSearchResult({
      ...existing,
      score: combined,
      matchType: "hybrid",
      scoreType: "hybrid",
      rawScore: combined,
      vectorScore,
      ftsRank: fts.ftsRank ?? fts.rawScore,
    });
  }
  return results;
}

const makeSemanticLibraryService = (_config: Config) =>
  Effect.gen(function* () {
    const documents = yield* DocumentRepository;
    const search = yield* SearchRepository;
    const maintenance = yield* LibraryMaintenance;
    const embedProvider = yield* EmbeddingProvider;
    const rebuild = yield* VectorRebuildRepository;

    /** Embeds texts in queue-sized batches, pausing between batches. */
    const embedTexts = (texts: readonly string[]) =>
      Effect.gen(function* () {
        const vectors: number[][] = [];
        const { batchSize, concurrency, batchDelayMs } = DEFAULT_QUEUE_CONFIG;
        for (let start = 0; start < texts.length; start += batchSize) {
          if (start > 0) yield* Effect.sleep(Duration.millis(batchDelayMs));
          vectors.push(
            ...(yield* embedProvider.embedBatch(
              texts.slice(start, start + batchSize),
              concurrency,
            )),
          );
        }
        return vectors;
      });

    const embedChunks = (doc: Document, chunks: readonly PDFChunk[]) =>
      Effect.map(
        embedTexts(
          chunks.map(
            (chunk) =>
              chunk.embeddingContent ?? buildEmbeddingContent(doc, chunk),
          ),
        ),
        (vectors): EmbeddingRecord[] =>
          chunks.map((chunk, index) => ({
            chunkId: chunk.id,
            embedding: vectors[index]!,
          })),
      );

    return {
      search: (
        query: string,
        options: SearchOptions = new SearchOptions({}),
      ) =>
        Effect.gen(function* () {
          const { hybrid } = options;
          const mapProviderFailure = (error: unknown) =>
            new SemanticSearchProviderError({
              provider: embedProvider.provider,
              reason: providerFailureReason(error),
            });
          yield* embedProvider.checkHealth().pipe(
            Effect.mapError(mapProviderFailure),
          );
          const queryEmbedding = yield* embedProvider.embed(query).pipe(
            Effect.mapError(mapProviderFailure),
          );
          const vectorResults = yield* search.vectorSearch(
            queryEmbedding,
            options,
          );
          const results = hybrid
            ? mergeHybridResults(
                vectorResults,
                yield* search.ftsSearch(query, options),
              )
            : vectorResults;

          return yield* expandSearchResults(results, options, search);
        }),
      reindexEmbeddings: (docId: string) =>
        Effect.gen(function* () {
          yield* embedProvider.checkHealth();
          const existing = yield* documents.getDocument(docId);
          if (!existing) {
            return yield* new DocumentNotFoundError({ query: docId });
          }
          const chunks = yield* documents.listChunksByDocument(docId);
          if (chunks.length === 0) {
            return yield* new DocumentNotFoundError({
              query: `No chunks found for document ${docId}`,
            });
          }

          const embeddingRecords = yield* embedChunks(existing, chunks);
          yield* documents.addEmbeddings(embeddingRecords);
          yield* maintenance.checkpoint();
          return {
            docId: existing.id,
            title: existing.title,
            chunks: chunks.length,
            embeddings: embeddingRecords.length,
          };
        }),

      /**
       * Re-embeds every chunk, concept vector, and cluster summary with the
       * configured model and swaps them in atomically. This is how a library
       * moves to a different embedding model or dimension.
       */
      rebuildEmbeddings: (
        onDocument: (
          doc: Document,
          index: number,
          total: number,
        ) => Effect.Effect<void> = () => Effect.void,
      ) =>
        Effect.gen(function* () {
          const dimensions = (yield* embedProvider.embed(DIMENSION_PROBE))
            .length;
          const docs = yield* documents.listDocuments();
          const rebuilt = yield* rebuild.rebuildVectors(
            dimensions,
            (staging) =>
              Effect.gen(function* () {
                let chunkCount = 0;
                for (const [index, doc] of docs.entries()) {
                  yield* onDocument(doc, index, docs.length);
                  const chunks = yield* documents.listChunksByDocument(doc.id);
                  yield* staging.stageChunkEmbeddings(
                    yield* embedChunks(doc, chunks),
                  );
                  chunkCount += chunks.length;
                }

                const concepts = yield* staging.listEmbeddedConcepts();
                const conceptVectors = yield* embedTexts(
                  concepts.map(conceptEmbeddingText),
                );
                yield* staging.stageConceptEmbeddings(
                  concepts.map((concept, index) => ({
                    conceptId: concept.id,
                    embedding: conceptVectors[index]!,
                  })),
                );

                const summaries = yield* staging.listClusterSummaries();
                const withText = summaries.filter(
                  (summary): summary is { id: number; summary: string } =>
                    summary.summary !== null,
                );
                const summaryVectors = yield* embedTexts(
                  withText.map((summary) => summary.summary),
                );
                const vectorById = new Map(
                  withText.map((summary, index) => [
                    summary.id,
                    summaryVectors[index]!,
                  ]),
                );
                yield* staging.stageClusterSummaryEmbeddings(
                  summaries.map((summary) => ({
                    id: summary.id,
                    embedding: vectorById.get(summary.id) ?? null,
                  })),
                );

                return {
                  documents: docs.length,
                  chunks: chunkCount,
                  concepts: concepts.length,
                  clusterSummaries: summaries.length,
                  dimensions,
                };
              }),
          );
          yield* maintenance.checkpoint();
          return rebuilt;
        }),
    };
  });

export type SemanticLibraryService = Effect.Effect.Success<
  ReturnType<typeof makeSemanticLibraryService>
>;

export class SemanticLibrary extends Context.Tag("SemanticLibrary")<
  SemanticLibrary,
  SemanticLibraryService
>() {}

export function makeSemanticLibrary(config: Config) {
  return Layer.effect(SemanticLibrary, makeSemanticLibraryService(config));
}
