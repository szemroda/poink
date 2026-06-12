import { Context, Duration, Effect, Layer } from "effect";
import {
  type Config,
  DocumentSearchResult,
  DocumentNotFoundError,
  SearchOptions,
  type Document,
  type PDFChunk,
} from "../types.js";
import { Database } from "./Database.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import { DEFAULT_QUEUE_CONFIG } from "./EmbeddingQueue.js";

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

const makeSemanticLibraryService = (_config: Config) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const embedProvider = yield* EmbeddingProvider;

    return {
      search: (
        query: string,
        options: SearchOptions = new SearchOptions({}),
      ) =>
        Effect.gen(function* () {
          const { hybrid, limit, expandChars = 0 } = options;
          const results: DocumentSearchResult[] = [];
          const healthCheck = yield* Effect.either(embedProvider.checkHealth());

          if (healthCheck._tag === "Right") {
            const queryEmbedding = yield* embedProvider.embed(query);
            results.push(...(yield* db.vectorSearch(queryEmbedding, options)));
          }

          if (hybrid || healthCheck._tag === "Left") {
            const ftsResults = yield* db.ftsSearch(query, options);
            for (const fts of ftsResults) {
              const existing = results.find(
                (result) =>
                  result.docId === fts.docId &&
                  result.page === fts.page &&
                  result.chunkIndex === fts.chunkIndex,
              );
              if (!existing) {
                results.push(fts);
                continue;
              }
              const vectorScore = existing.vectorScore ?? existing.score;
              const combined = Math.min(
                1,
                Math.max(vectorScore, fts.score) * 1.05,
              );
              results[results.indexOf(existing)] = new DocumentSearchResult({
                ...existing,
                score: combined,
                matchType: "hybrid",
                scoreType: "hybrid",
                rawScore: combined,
                vectorScore,
                ftsRank: fts.ftsRank ?? fts.rawScore,
              });
            }
          }

          const effectiveExpand = expandChars > 0 ? expandChars : 500;
          return yield* Effect.all(
            results
              .sort((a, b) => b.score - a.score)
              .slice(0, limit)
              .map((result) =>
                Effect.map(
                  db.getExpandedContext(
                    result.docId,
                    result.page,
                    result.chunkIndex,
                    { maxChars: effectiveExpand },
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
        }),
      reindexEmbeddings: (docId: string) =>
        Effect.gen(function* () {
          yield* embedProvider.checkHealth();
          const existing = yield* db.getDocument(docId);
          if (!existing) {
            return yield* Effect.fail(
              new DocumentNotFoundError({ query: docId }),
            );
          }
          const chunks = yield* db.listChunksByDocument(docId);
          if (chunks.length === 0) {
            return yield* Effect.fail(
              new DocumentNotFoundError({
                query: `No chunks found for document ${docId}`,
              }),
            );
          }

          const embeddingRecords: Array<{
            chunkId: string;
            embedding: number[];
          }> = [];
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

          yield* db.addEmbeddings(embeddingRecords);
          yield* db.checkpoint();
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
