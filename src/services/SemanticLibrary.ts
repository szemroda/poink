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
} from "./StorageRepositories.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import { DEFAULT_QUEUE_CONFIG } from "./EmbeddingQueue.js";

type EmbeddingRecord = {
  chunkId: string;
  embedding: number[];
};

function sectionFromChunkContent(content: string): string | null {
  return content.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function tableEmbeddingText(content: string): string | null {
  const tables = content.match(
    /\|[^\n]+\|\n\|[-:\s|]+\|\n(?:\|[^\n]+\|\n?)+/g,
  );
  if (!tables) return null;

  const rendered: string[] = [];
  for (const table of tables) {
    const lines = table.trim().split("\n");
    const columns = parseMarkdownTableRow(lines[0] ?? "");
    if (columns.length === 0) continue;
    const rows = lines.slice(2).map(parseMarkdownTableRow);
    rendered.push(`Columns: ${columns.join(" | ")}`);
    rows.forEach((row, index) => {
      const values = columns.map(
        (column, cellIndex) => `${column}=${row[cellIndex] ?? ""}`,
      );
      rendered.push(`Row ${index + 1}: ${values.join("; ")}`);
    });
  }
  return rendered.length > 0 ? rendered.join("\n") : null;
}

function buildEmbeddingContent(doc: Document, chunk: PDFChunk): string {
  const context = [`Document: ${doc.title}`];
  const section = sectionFromChunkContent(chunk.content);
  if (section) context.push(`Section: ${section}`);
  if (chunk.page > 0) context.push(`Page: ${chunk.page}`);
  const baseContent = chunk.embeddingContent ?? chunk.content;
  const tableContent = tableEmbeddingText(baseContent);
  const body = tableContent
    ? `${baseContent}\n\n${tableContent}`
    : baseContent;
  return `${context.join("\n")}\n\n${body}`;
}

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

function expandSearchResults(
  results: readonly DocumentSearchResult[],
  limit: number,
  expandChars: number,
  search: Context.Tag.Service<typeof SearchRepository>,
) {
  const maxChars = expandChars > 0 ? expandChars : 500;
  return Effect.all(
    [...results]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((result) =>
        Effect.map(
          search.getExpandedContext(
            result.docId,
            result.page,
            result.chunkIndex,
            { maxChars },
          ),
          (expanded) =>
            new DocumentSearchResult({
              ...result,
              expandedContent: expanded.content,
              expandedRange: { start: 0, end: 0 },
            }),
        ),
      ),
  );
}

const makeSemanticLibraryService = (_config: Config) =>
  Effect.gen(function* () {
    const documents = yield* DocumentRepository;
    const search = yield* SearchRepository;
    const maintenance = yield* LibraryMaintenance;
    const embedProvider = yield* EmbeddingProvider;

    return {
      search: (
        query: string,
        options: SearchOptions = new SearchOptions({}),
      ) =>
        Effect.gen(function* () {
          const { hybrid, limit, expandChars = 0 } = options;
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

          return yield* expandSearchResults(
            results,
            limit,
            expandChars,
            search,
          );
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

          const embeddingRecords: EmbeddingRecord[] = [];
          const batchSize = DEFAULT_QUEUE_CONFIG.batchSize;

          for (
            let batchIndex = 0;
            batchIndex * batchSize < chunks.length;
            batchIndex++
          ) {
            const batchStart = batchIndex * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, chunks.length);
            const batchChunks = chunks.slice(batchStart, batchEnd);
            const embeddings = yield* embedProvider.embedBatch(
              batchChunks.map(
                (chunk) =>
                  chunk.embeddingContent ??
                  buildEmbeddingContent(existing, chunk),
              ),
              DEFAULT_QUEUE_CONFIG.concurrency,
            );
            embeddings.forEach((embedding, index) => {
              embeddingRecords.push({
                chunkId: batchChunks[index]!.id,
                embedding,
              });
            });
            if (batchEnd < chunks.length) {
              yield* Effect.sleep(
                Duration.millis(DEFAULT_QUEUE_CONFIG.batchDelayMs),
              );
            }
          }

          yield* documents.addEmbeddings(embeddingRecords);
          yield* maintenance.checkpoint();
          return {
            docId: existing.id,
            title: existing.title,
            chunks: chunks.length,
            embeddings: embeddingRecords.length,
          };
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
