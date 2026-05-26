/**
 * PDF Library - Local PDF knowledge base with vector search
 *
 * Built with Effect for robust error handling and composability.
 */

import { Duration, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";

import {
  AddOptions,
  Config,
  Document,
  DocumentExistsError,
  type DocumentFileType,
  DocumentNotFoundError,
  expandHomePath,
  LibraryConfig,
  loadConfig,
  resolveVisualsConfig,
  SearchOptions,
  SearchResult,
} from "./types.js";
import { DEFAULT_QUEUE_CONFIG } from "./services/EmbeddingQueue.js";

import {
  EmbeddingProvider,
  EmbeddingProviderLive,
  EmbeddingProviderFullLive,
} from "./services/EmbeddingProvider.js";
import type { EmbeddingError } from "./services/EmbeddingProvider.js";
import {
  chunkText,
  PDFExtractor,
  PDFExtractorLive,
} from "./services/PDFExtractor.js";
import {
  MarkdownExtractor,
  MarkdownExtractorLive,
} from "./services/MarkdownExtractor.js";
import {
  OfficeExtractor,
  OfficeExtractorLive,
} from "./services/OfficeExtractor.js";
import {
  VisualEnrichment,
  VisualEnrichmentLive,
  type VisualDescriptionChunk,
  type VisualsMode,
} from "./services/VisualEnrichment.js";
import { Database } from "./services/Database.js";
import { LibSQLDatabase } from "./services/LibSQLDatabase.js";
import { DatabaseRegistry } from "./services/DatabaseRegistry.js";
import { buildChunkerMetadata, inferFileTypeFromPath } from "./chunking.js";

// Re-export types and services
export * from "./types.js";
export {
  Ollama,
  OllamaLive,
  probeEmbeddingDimension,
  getEmbeddingDimension,
} from "./services/Ollama.js";
export {
  EmbeddingProvider,
  EmbeddingProviderLive,
  EmbeddingProviderFullLive,
} from "./services/EmbeddingProvider.js";
export type { EmbeddingError } from "./services/EmbeddingProvider.js";
export { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";
export {
  MarkdownExtractor,
  MarkdownExtractorLive,
} from "./services/MarkdownExtractor.js";
export {
  OfficeExtractor,
  OfficeExtractorLive,
} from "./services/OfficeExtractor.js";
export {
  VisualEnrichment,
  VisualEnrichmentLive,
  type ExtractedDocumentImage,
  type VisualDescriptionChunk,
  type VisualsMode,
} from "./services/VisualEnrichment.js";
export { Database } from "./services/Database.js";
export { LibSQLDatabase } from "./services/LibSQLDatabase.js";
export { DatabaseRegistry } from "./services/DatabaseRegistry.js";

// ============================================================================
// Helper Functions
// ============================================================================

const DOCUMENT_TITLE_EXTENSION_RE = /\.(pdf|md|markdown|docx|odt|fodt)$/i;

type LibraryProcessedChunk = {
  page: number;
  chunkIndex: number;
  content: string;
  embeddingContent?: string;
};

// ============================================================================
// Library Service
// ============================================================================

/**
 * Main PDF Library service that composes all dependencies
 */
export class PDFLibrary extends Effect.Service<PDFLibrary>()("PDFLibrary", {
  effect: Effect.gen(function* () {
    const embedProvider = yield* EmbeddingProvider;
    const pdfExtractor = yield* PDFExtractor;
    const markdownExtractor = yield* MarkdownExtractor;
    const officeExtractor = yield* OfficeExtractor;
    const visualEnrichment = yield* VisualEnrichment;
    const db = yield* Database;
    const config = LibraryConfig.fromEnv();

    const fallbackTitle = (path: string) =>
      basename(path).replace(DOCUMENT_TITLE_EXTENSION_RE, "");

    const resolveTitle = (
      resolvedPath: string,
      fileType: DocumentFileType,
      explicitTitle?: string,
    ) =>
      Effect.gen(function* () {
        if (explicitTitle) return explicitTitle;
        if (fileType !== "markdown") return fallbackTitle(resolvedPath);

        const frontmatterResult = yield* Effect.either(
          markdownExtractor.extractFrontmatter(resolvedPath),
        );
        if (
          frontmatterResult._tag === "Right" &&
          frontmatterResult.right.title
        ) {
          return frontmatterResult.right.title;
        }

        const extractResult = yield* Effect.either(
          markdownExtractor.extract(resolvedPath),
        );
        if (
          extractResult._tag === "Right" &&
          extractResult.right.sections.length > 0
        ) {
          const firstHeading = extractResult.right.sections.find(
            (section) => section.heading,
          );
          return firstHeading?.heading || fallbackTitle(resolvedPath);
        }

        return fallbackTitle(resolvedPath);
      });

    const configuredVisualsMode = (
      appConfig: Config,
      options: AddOptions,
    ): VisualsMode => {
      if (options.visuals === true) return options.visualsMode ?? "explicit";
      return resolveVisualsConfig(appConfig).enabled ? "config" : "disabled";
    };

    const splitVisualChunk = (
      visual: VisualDescriptionChunk,
      startChunkIndex: number,
    ): LibraryProcessedChunk[] => {
      if (visual.content.length <= config.chunkSize) {
        return [
          {
            page: visual.page,
            chunkIndex: startChunkIndex,
            content: visual.content,
            embeddingContent: visual.embeddingContent,
          },
        ];
      }

      const header = visual.content.split("\n")[0]?.trim();
      return chunkText(
        visual.content,
        config.chunkSize,
        config.chunkOverlap,
      ).map((content, index) => {
        const display =
          header && !content.includes(header)
            ? `${header}\n\n${content}`
            : content;
        return {
          page: visual.page,
          chunkIndex: startChunkIndex + index,
          content: display,
          embeddingContent: visual.embeddingContent,
        };
      });
    };

    const appendVisualChunks = (
      textResult: { pageCount: number; chunks: LibraryProcessedChunk[] },
      visualChunks: VisualDescriptionChunk[],
    ): { pageCount: number; chunks: LibraryProcessedChunk[] } => {
      if (visualChunks.length === 0) return textResult;

      const merged = [...textResult.chunks];
      let nextChunkIndex =
        merged.reduce((max, chunk) => Math.max(max, chunk.chunkIndex), -1) + 1;

      for (const visual of visualChunks) {
        const chunks = splitVisualChunk(visual, nextChunkIndex);
        merged.push(...chunks);
        nextChunkIndex += chunks.length;
      }

      return { pageCount: textResult.pageCount, chunks: merged };
    };

    const processDocument = (
      resolvedPath: string,
      fileType: DocumentFileType,
      options: {
        visualsMode: VisualsMode;
        title?: string;
      },
    ): Effect.Effect<
      { pageCount: number; chunks: LibraryProcessedChunk[] },
      unknown
    > =>
      Effect.gen(function* () {
        const textResult = yield* (() => {
          if (fileType === "markdown")
            return markdownExtractor.process(resolvedPath);
          if (fileType === "docx" || fileType === "odt") {
            return officeExtractor.process(resolvedPath);
          }
          return pdfExtractor.process(resolvedPath);
        })();

        if (options.visualsMode === "disabled") return textResult;

        const visualChunks = yield* visualEnrichment.enrichDocument(
          resolvedPath,
          fileType,
          {
            mode: options.visualsMode,
            title: options.title,
          },
        );

        return appendVisualChunks(textResult, visualChunks);
      });

    const sectionFromChunkContent = (content: string): string | null => {
      const heading = content.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
      return heading || null;
    };

    const parseMarkdownTableRow = (line: string): string[] =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim().replace(/\\\|/g, "|"));

    const tableEmbeddingText = (content: string): string | null => {
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
    };

    const buildEmbeddingContent = (
      doc: Document,
      chunk: LibraryProcessedChunk,
    ): string => {
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
    };

    return {
      /**
       * Check if embedding provider is ready
       */
      checkReady: () => embedProvider.checkHealth(),

      /**
       * Add a PDF or Markdown file to the library
       */
      add: (pdfPath: string, options: AddOptions = new AddOptions({})) =>
        Effect.gen(function* () {
          // Resolve path
          const resolvedPath = expandHomePath(pdfPath);

          // Check if already exists
          const existing = yield* db.getDocumentByPath(resolvedPath);
          if (existing) {
            return yield* Effect.fail(
              new DocumentExistsError({
                title: existing.title,
                path: resolvedPath,
              }),
            );
          }

          // Check embedding provider
          yield* embedProvider.checkHealth();

          const stat = statSync(resolvedPath);
          const id = createHash("sha256")
            .update(resolvedPath)
            .digest("hex")
            .slice(0, 12);

          // Detect file type and route to appropriate extractor
          const fileType = inferFileTypeFromPath(resolvedPath);

          const title = yield* resolveTitle(
            resolvedPath,
            fileType,
            options.title,
          );
          const appConfig = loadConfig();
          const visualsMode = configuredVisualsMode(appConfig, options);
          const processResult = yield* Effect.either(
            processDocument(resolvedPath, fileType, { visualsMode, title }),
          );
          if (processResult._tag === "Left") {
            yield* Effect.logDebug(
              `${fileType} extraction failed for ${resolvedPath}: ${processResult.left}`,
            );
            return yield* Effect.fail(processResult.left);
          }
          const { pageCount, chunks } = processResult.right;

          if (chunks.length === 0) {
            return yield* Effect.fail(
              new DocumentNotFoundError({
                query: `No text content extracted from ${fileType}`,
              }),
            );
          }

          // Create document
          const chunker = buildChunkerMetadata(fileType, config);
          const mergedMetadata: Record<string, unknown> = {
            ...(options.metadata ?? {}),
            // Always stamp the chunker used to generate the current chunks/embeddings.
            chunker,
            visuals: {
              enabled: visualsMode !== "disabled",
              version: 1,
              maxImageBytes: resolveVisualsConfig(appConfig).maxImageBytes,
              maxImagesPerDocument:
                resolveVisualsConfig(appConfig).maxImagesPerDocument,
            },
          };

          const doc = new Document({
            id,
            title,
            path: resolvedPath,
            addedAt: options.addedAt ?? new Date(),
            pageCount,
            sizeBytes: stat.size,
            tags: options.tags || [],
            fileType,
            metadata: mergedMetadata,
          });

          const chunkRecords = chunks.map((chunk, i) => ({
            id: `${id}-${i}`,
            docId: id,
            page: chunk.page,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            embeddingContent: buildEmbeddingContent(doc, chunk),
          }));

          // Generate embeddings with gated batching to prevent WASM OOM.
          // Generate every embedding before touching the DB. Otherwise a
          // mid-file embedding failure can leave a document/chunks row that
          // causes later ingest runs to skip an incomplete vector index.
          const batchSize = DEFAULT_QUEUE_CONFIG.batchSize;
          yield* Effect.logDebug(
            `Generating embeddings for ${chunks.length} chunks (batch size: ${batchSize})...`,
          );

          const contents = chunkRecords.map(
            (c) => c.embeddingContent ?? c.content,
          );
          const embeddingRecords: Array<{
            chunkId: string;
            embedding: number[];
          }> = [];

          // Process embeddings in gated batches, then commit once below.
          for (
            let batchIdx = 0;
            batchIdx * batchSize < contents.length;
            batchIdx++
          ) {
            const batchStart = batchIdx * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, contents.length);
            const batchContents = contents.slice(batchStart, batchEnd);

            yield* Effect.logDebug(
              `  Batch ${batchIdx}: generating embeddings for indices ${batchStart}-${
                batchEnd - 1
              }`,
            );

            // Generate embeddings for this batch with bounded concurrency
            const batchEmbeddings = yield* embedProvider.embedBatch(
              batchContents,
              DEFAULT_QUEUE_CONFIG.concurrency,
            );

            yield* Effect.logDebug(
              `  Batch ${batchIdx}: got ${batchEmbeddings.length} embeddings`,
            );

            // NOTE: Use explicit for-loop to avoid Effect generator closure issues
            // The .map() closure was capturing stale batchStart values
            for (let i = 0; i < batchEmbeddings.length; i++) {
              const chunkIndex = batchIdx * batchSize + i;
              embeddingRecords.push({
                chunkId: `${id}-${chunkIndex}`,
                embedding: batchEmbeddings[i],
              });
            }

            yield* Effect.logDebug(
              `  Batch ${batchIdx}: prepared embeddings for ${id}-${batchStart} to ${id}-${
                batchEnd - 1
              }`,
            );

            yield* Effect.logDebug(
              `  Processed ${batchEnd}/${contents.length} embeddings`,
            );

            // Backpressure: small delay between batches to let GC run
            if (batchEnd < contents.length) {
              yield* Effect.sleep(
                Duration.millis(DEFAULT_QUEUE_CONFIG.batchDelayMs),
              );
            }
          }

          // Commit document + chunks + embeddings atomically only after all
          // embeddings have been generated.
          yield* db.replaceDocument(doc, chunkRecords, embeddingRecords);
          yield* db.checkpoint();

          return doc;
        }),

      /**
       * Replace/rebuild an existing document in-place (non-destructive).
       *
       * This is the agent-safe primitive used by `poink rechunk`.
       * The DB update is performed as a single transaction: doc upsert +
       * delete old chunks + insert new chunks + insert new embeddings.
       */
      replace: (pdfPath: string, options: AddOptions = new AddOptions({})) =>
        Effect.gen(function* () {
          // Resolve path
          const resolvedPath = expandHomePath(pdfPath);

          // Require existing doc (this is "replace", not "add")
          const existing = yield* db.getDocumentByPath(resolvedPath);
          if (!existing) {
            return yield* Effect.fail(
              new DocumentNotFoundError({ query: resolvedPath }),
            );
          }

          // Check embedding provider before doing any work
          yield* embedProvider.checkHealth();

          const stat = statSync(resolvedPath);
          const id = existing.id;

          // Detect file type and route to appropriate extractor
          const fileType = inferFileTypeFromPath(resolvedPath);

          // Preserve existing title/tags/metadata by default
          const title = options.title ?? existing.title;
          const tags = options.tags ?? existing.tags;
          const baseMetadata: Record<string, unknown> =
            options.metadata ?? existing.metadata ?? {};

          const appConfig = loadConfig();
          const visualsMode = configuredVisualsMode(appConfig, options);
          const processResult = yield* Effect.either(
            processDocument(resolvedPath, fileType, { visualsMode, title }),
          );
          if (processResult._tag === "Left") {
            return yield* Effect.fail(processResult.left);
          }
          const { pageCount, chunks } = processResult.right;

          if (chunks.length === 0) {
            return yield* Effect.fail(
              new DocumentNotFoundError({
                query: `No text content extracted from ${fileType}`,
              }),
            );
          }

          // Stamp current chunker metadata (always overwrite)
          const chunker = buildChunkerMetadata(fileType, config);
          const mergedMetadata: Record<string, unknown> = {
            ...baseMetadata,
            chunker,
            visuals: {
              enabled: visualsMode !== "disabled",
              version: 1,
              maxImageBytes: resolveVisualsConfig(appConfig).maxImageBytes,
              maxImagesPerDocument:
                resolveVisualsConfig(appConfig).maxImagesPerDocument,
            },
          };

          const doc = new Document({
            id,
            title,
            path: resolvedPath,
            addedAt: options.addedAt ?? existing.addedAt,
            pageCount,
            sizeBytes: stat.size,
            tags,
            fileType,
            metadata: mergedMetadata,
          });

          const chunkRecords = chunks.map((chunk, i) => ({
            id: `${id}-${i}`,
            docId: id,
            page: chunk.page,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            embeddingContent: buildEmbeddingContent(doc, chunk),
          }));

          // Generate all embeddings before touching the DB (non-destructive).
          const batchSize = DEFAULT_QUEUE_CONFIG.batchSize;
          const contents = chunkRecords.map(
            (c) => c.embeddingContent ?? c.content,
          );

          const embeddingRecords: Array<{
            chunkId: string;
            embedding: number[];
          }> = [];

          for (
            let batchIdx = 0;
            batchIdx * batchSize < contents.length;
            batchIdx++
          ) {
            const batchStart = batchIdx * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, contents.length);
            const batchContents = contents.slice(batchStart, batchEnd);

            const batchEmbeddings = yield* embedProvider.embedBatch(
              batchContents,
              DEFAULT_QUEUE_CONFIG.concurrency,
            );

            for (let i = 0; i < batchEmbeddings.length; i++) {
              const chunkIndex = batchIdx * batchSize + i;
              embeddingRecords.push({
                chunkId: `${id}-${chunkIndex}`,
                embedding: batchEmbeddings[i],
              });
            }

            if (batchEnd < contents.length) {
              yield* Effect.sleep(
                Duration.millis(DEFAULT_QUEUE_CONFIG.batchDelayMs),
              );
            }
          }

          // Atomic DB replacement
          yield* db.replaceDocument(doc, chunkRecords, embeddingRecords);
          yield* db.checkpoint();

          return doc;
        }),

      /**
       * Re-generate embeddings for an existing document using the current
       * embedding provider and model, without touching the document row or
       * chunks (non-destructive).
       *
       * This is the agent-safe primitive used by `poink reindex`.
       *
       * Note: we upsert embeddings by chunkId, so repeated calls are safe.
       */
      reindexEmbeddings: (docId: string) =>
        Effect.gen(function* () {
          // Require embedding provider (reindex is meaningless without it)
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

          const batchSize = DEFAULT_QUEUE_CONFIG.batchSize;
          const embeddingRecords: Array<{
            chunkId: string;
            embedding: number[];
          }> = [];

          for (
            let batchIdx = 0;
            batchIdx * batchSize < chunks.length;
            batchIdx++
          ) {
            const batchStart = batchIdx * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, chunks.length);
            const batchChunks = chunks.slice(batchStart, batchEnd);
            const batchContents = batchChunks.map(
              (c) => c.embeddingContent ?? buildEmbeddingContent(existing, c),
            );

            const batchEmbeddings = yield* embedProvider.embedBatch(
              batchContents,
              DEFAULT_QUEUE_CONFIG.concurrency,
            );

            for (let i = 0; i < batchEmbeddings.length; i++) {
              embeddingRecords.push({
                chunkId: batchChunks[i]!.id,
                embedding: batchEmbeddings[i]!,
              });
            }

            if (batchEnd < chunks.length) {
              yield* Effect.sleep(
                Duration.millis(DEFAULT_QUEUE_CONFIG.batchDelayMs),
              );
            }
          }

          // Atomic upsert for this document's embeddings.
          yield* db.addEmbeddings(embeddingRecords);
          yield* db.checkpoint();

          return {
            docId: existing.id,
            title: existing.title,
            chunks: chunks.length,
            embeddings: embeddingRecords.length,
          };
        }),

      /**
       * Search the library
       */
      search: (query: string, options: SearchOptions = new SearchOptions({})) =>
        Effect.gen(function* () {
          const { hybrid, limit, expandChars = 0 } = options;
          const results: SearchResult[] = [];

          // Vector search
          const healthCheck = yield* Effect.either(embedProvider.checkHealth());
          if (healthCheck._tag === "Right") {
            const queryEmbedding = yield* embedProvider.embed(query);
            const vectorResults = yield* db.vectorSearch(
              queryEmbedding,
              options,
            );
            results.push(...vectorResults);
          }

          // FTS search (if hybrid or vector unavailable)
          if (hybrid || healthCheck._tag === "Left") {
            const ftsResults = yield* db.ftsSearch(query, options);

            // Merge results, avoiding duplicates
            for (const fts of ftsResults) {
              const exists = results.find(
                (r) =>
                  r.docId === fts.docId &&
                  r.page === fts.page &&
                  r.chunkIndex === fts.chunkIndex,
              );
              if (!exists) {
                results.push(fts);
              } else {
                // Combine signals for matches found in both vector + FTS.
                const vectorScore = exists.vectorScore ?? exists.score;
                const ftsScore = fts.score; // already normalized 0..1
                const combined = Math.min(
                  1,
                  Math.max(vectorScore, ftsScore) * 1.05,
                );

                const boosted = new SearchResult({
                  ...exists,
                  score: combined,
                  matchType: "hybrid",
                  scoreType: "hybrid",
                  rawScore: combined,
                  vectorScore,
                  ftsRank: fts.ftsRank ?? fts.rawScore,
                });
                const idx = results.indexOf(exists);
                results[idx] = boosted;
              }
            }
          }

          // Sort by score and limit
          let finalResults = results
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

          // Expand context if requested (default to 500 chars for useful snippets)
          const effectiveExpand = expandChars > 0 ? expandChars : 500;
          {
            // Dedupe expansion: track which (docId, page range) we've already expanded
            const expandedCache = new Map<
              string,
              { startChunk: string; endChunk: string; content: string }
            >();

            finalResults = yield* Effect.all(
              finalResults.map((result) =>
                Effect.gen(function* () {
                  // Fetch expanded context
                  const expanded = yield* db.getExpandedContext(
                    result.docId,
                    result.page,
                    result.chunkIndex,
                    { maxChars: effectiveExpand },
                  );

                  // Cache key includes page for dedup
                  const key = `${result.docId}:p${result.page}:c${result.chunkIndex}`;
                  expandedCache.set(key, {
                    startChunk: expanded.startChunk,
                    endChunk: expanded.endChunk,
                    content: expanded.content,
                  });

                  return new SearchResult({
                    ...result,
                    expandedContent: expanded.content,
                    expandedRange: {
                      start: 0,
                      end: 0,
                    },
                  });
                }),
              ),
            );
          }

          return finalResults;
        }),

      /**
       * Full-text search only (no embeddings)
       */
      ftsSearch: (
        query: string,
        options: SearchOptions = new SearchOptions({}),
      ) => db.ftsSearch(query, options),

      /**
       * Get a chunk by its unique chunk ID
       */
      getChunk: (chunkId: string) => db.getChunk(chunkId),

      /**
       * List chunks for a document (optionally filter by page)
       */
      listChunksByDocument: (docId: string, opts?: { page?: number }) =>
        db.listChunksByDocument(docId, opts),

      /**
       * List all documents
       */
      list: (tag?: string) => db.listDocuments(tag),

      /**
       * Get a document by ID or title
       */
      get: (idOrTitle: string) =>
        Effect.gen(function* () {
          // Try by ID first
          const byId = yield* db.getDocument(idOrTitle);
          if (byId) return byId;

          // Try by title (case-insensitive partial match)
          const docs = yield* db.listDocuments();
          return (
            docs.find(
              (d) =>
                d.title.toLowerCase().includes(idOrTitle.toLowerCase()) ||
                d.id.startsWith(idOrTitle),
            ) || null
          );
        }),

      /**
       * Remove a document
       */
      remove: (idOrTitle: string) =>
        Effect.gen(function* () {
          const doc = yield* Effect.flatMap(Effect.succeed(idOrTitle), (id) =>
            Effect.gen(function* () {
              const byId = yield* db.getDocument(id);
              if (byId) return byId;

              const docs = yield* db.listDocuments();
              return (
                docs.find(
                  (d) =>
                    d.title.toLowerCase().includes(id.toLowerCase()) ||
                    d.id.startsWith(id),
                ) || null
              );
            }),
          );

          if (!doc) {
            return yield* Effect.fail(
              new DocumentNotFoundError({ query: idOrTitle }),
            );
          }

          yield* db.deleteDocument(doc.id);
          return doc;
        }),

      /**
       * Update tags on a document
       */
      tag: (idOrTitle: string, tags: string[]) =>
        Effect.gen(function* () {
          const doc = yield* Effect.flatMap(Effect.succeed(idOrTitle), (id) =>
            Effect.gen(function* () {
              const byId = yield* db.getDocument(id);
              if (byId) return byId;

              const docs = yield* db.listDocuments();
              return (
                docs.find(
                  (d) =>
                    d.title.toLowerCase().includes(id.toLowerCase()) ||
                    d.id.startsWith(id),
                ) || null
              );
            }),
          );

          if (!doc) {
            return yield* Effect.fail(
              new DocumentNotFoundError({ query: idOrTitle }),
            );
          }

          yield* db.updateTags(doc.id, tags);
          return doc;
        }),

      /**
       * Get library statistics
       */
      stats: () =>
        Effect.gen(function* () {
          const dbStats = yield* db.getStats();
          return {
            ...dbStats,
            libraryPath: config.libraryPath,
          };
        }),

      /**
       * Cheap aggregation helper for agent workflows (planning/estimation).
       * Avoids loading chunk bodies into memory just to count.
       */
      countChunksByDocumentIds: (docIds: string[]) =>
        db.countChunksByDocumentIds(docIds),

      /**
       * Repair database integrity issues
       * Removes orphaned chunks and embeddings
       */
      repair: () => db.repair(),

      /**
       * Force database checkpoint to flush WAL to data files
       * Call this after batch operations to prevent WAL accumulation
       */
      checkpoint: () => db.checkpoint(),
    };
  }),
  dependencies: [
    EmbeddingProviderFullLive,
    PDFExtractorLive,
    MarkdownExtractorLive,
    OfficeExtractorLive,
    VisualEnrichmentLive.pipe(
      Layer.provide(Layer.merge(PDFExtractorLive, OfficeExtractorLive)),
    ),
  ],
}) {}

// ============================================================================
// Convenience Layer
// ============================================================================

/**
 * Full application layer with all services using LibSQL database
 * using the configured database backend via DatabaseRegistry.
 */
export const makePDFLibraryLive = () => {
  const dbLayer = DatabaseRegistry.make();

  // Provide all dependencies internally: the configured embedding provider and database.
  // This makes PDFLibraryLive a complete, self-contained layer
  const fullDeps = Layer.merge(EmbeddingProviderFullLive, dbLayer);

  return PDFLibrary.Default.pipe(Layer.provide(fullDeps));
};

export const PDFLibraryLive = makePDFLibraryLive();
