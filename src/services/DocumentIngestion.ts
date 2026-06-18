/**
 * Document ingestion service.
 *
 * Built with Effect for robust error handling and composability.
 */

import { Context, Duration, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  AddOptions,
  Config,
  Document,
  DocumentExistsError,
  DocumentNotFoundError,
  expandHomePath,
  LibraryConfig,
  resolveVisualsConfig,
} from "../types.js";
import { DEFAULT_QUEUE_CONFIG } from "./EmbeddingQueue.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import { chunkText, PDFExtractor } from "./PDFExtractor.js";
import { MarkdownExtractor } from "./MarkdownExtractor.js";
import { OfficeExtractor } from "./OfficeExtractor.js";
import {
  VisualEnrichment,
  type VisualDescriptionChunk,
  type VisualsMode,
} from "./VisualEnrichment.js";
import {
  DocumentIntegrityRepository,
  DocumentRepository,
  LibraryMaintenance,
  type ChunkInput,
  type EmbeddingInput,
} from "./StorageRepositories.js";
import { buildChunkerMetadata } from "../chunking.js";
import {
  assertStableSource,
  fingerprintSource,
} from "./SourceIntegrity.js";
import {
  isOfficeDetectedSourceType,
  SourceFileTypeDetector,
  type DetectedSourceType,
} from "./SourceFileType.js";

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

const makeDocumentIngestionService = (appConfig: Config) =>
  Effect.gen(function* () {
    const embedProvider = yield* EmbeddingProvider;
    const pdfExtractor = yield* PDFExtractor;
    const markdownExtractor = yield* MarkdownExtractor;
    const officeExtractor = yield* OfficeExtractor;
    const visualEnrichment = yield* VisualEnrichment;
    const sourceFileTypeDetector = yield* SourceFileTypeDetector;
    const documents = yield* DocumentRepository;
    const documentIntegrity = yield* DocumentIntegrityRepository;
    const maintenance = yield* LibraryMaintenance;
    const config = LibraryConfig.fromConfig(appConfig);
    const visualsConfig = resolveVisualsConfig(appConfig);

    const fallbackTitle = (path: string) =>
      basename(path).replace(DOCUMENT_TITLE_EXTENSION_RE, "");

    const resolveDetectedSourceType = (
      resolvedPath: string,
      options: AddOptions,
    ) =>
      options.sourceContext?.detectedType
        ? Effect.succeed(options.sourceContext.detectedType)
        : sourceFileTypeDetector.detect(resolvedPath);

    const resolveInitialFingerprint = (
      resolvedPath: string,
      options: AddOptions,
    ) =>
      options.sourceContext?.initialFingerprint
        ? Effect.succeed(options.sourceContext.initialFingerprint)
        : fingerprintSource(resolvedPath);

    const resolveTitle = (
      resolvedPath: string,
      detected: DetectedSourceType,
      explicitTitle?: string,
    ) =>
      Effect.gen(function* () {
        if (explicitTitle) return explicitTitle;
        if (detected.fileType !== "markdown") {
          return fallbackTitle(resolvedPath);
        }

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
      return visualsConfig.enabled ? "config" : "disabled";
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

    const extractDocumentText = (
      resolvedPath: string,
      detected: DetectedSourceType,
    ) => {
      if (detected.fileType === "markdown") {
        return markdownExtractor.process(resolvedPath);
      }
      if (isOfficeDetectedSourceType(detected)) {
        return officeExtractor.process(resolvedPath, detected.sourceFormat);
      }
      return pdfExtractor.process(resolvedPath);
    };

    const processDocument = (
      resolvedPath: string,
      detected: DetectedSourceType,
      options: {
        visualsMode: VisualsMode;
        title?: string;
      },
    ): Effect.Effect<
      { pageCount: number; chunks: LibraryProcessedChunk[] },
      unknown
    > =>
      Effect.gen(function* () {
        const textResult = yield* extractDocumentText(resolvedPath, detected);

        if (options.visualsMode === "disabled") return textResult;

        const visualChunks = yield* visualEnrichment.enrichDocument(
          resolvedPath,
          detected,
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

    const generateEmbeddings = (
      documentId: string,
      chunks: readonly ChunkInput[],
      logProgress: boolean,
    ): Effect.Effect<EmbeddingInput[], unknown> =>
      Effect.gen(function* () {
        const batchSize = DEFAULT_QUEUE_CONFIG.batchSize;
        const contents = chunks.map(
          (chunk) => chunk.embeddingContent ?? chunk.content,
        );
        const embeddings: EmbeddingInput[] = [];

        if (logProgress) {
          yield* Effect.logDebug(
            `Generating embeddings for ${chunks.length} chunks (batch size: ${batchSize})...`,
          );
        }

        for (
          let batchIndex = 0;
          batchIndex * batchSize < contents.length;
          batchIndex++
        ) {
          const batchStart = batchIndex * batchSize;
          const batchEnd = Math.min(batchStart + batchSize, contents.length);
          const batchContents = contents.slice(batchStart, batchEnd);

          if (logProgress) {
            yield* Effect.logDebug(
              `  Batch ${batchIndex}: generating embeddings for indices ${batchStart}-${batchEnd - 1}`,
            );
          }

          const batchEmbeddings = yield* embedProvider.embedBatch(
            batchContents,
            DEFAULT_QUEUE_CONFIG.concurrency,
          );

          for (let index = 0; index < batchEmbeddings.length; index++) {
            embeddings.push({
              chunkId: `${documentId}-${batchStart + index}`,
              embedding: batchEmbeddings[index],
            });
          }

          if (logProgress) {
            yield* Effect.logDebug(
              `  Batch ${batchIndex}: got ${batchEmbeddings.length} embeddings`,
            );
            yield* Effect.logDebug(
              `  Batch ${batchIndex}: prepared embeddings for ${documentId}-${batchStart} to ${documentId}-${batchEnd - 1}`,
            );
            yield* Effect.logDebug(
              `  Processed ${batchEnd}/${contents.length} embeddings`,
            );
          }

          if (batchEnd < contents.length) {
            yield* Effect.sleep(
              Duration.millis(DEFAULT_QUEUE_CONFIG.batchDelayMs),
            );
          }
        }

        return embeddings;
      });

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
          const existing =
            yield* documents.getDocumentByPath(resolvedPath);
          if (existing) {
            return yield* new DocumentExistsError({
              title: existing.title,
              path: resolvedPath,
            });
          }

          const initialFingerprint = yield* resolveInitialFingerprint(
            resolvedPath,
            options,
          );

          // Check embedding provider
          yield* embedProvider.checkHealth();

          const id = createHash("sha256")
            .update(resolvedPath)
            .digest("hex")
            .slice(0, 12);

          const detected = yield* resolveDetectedSourceType(
            resolvedPath,
            options,
          );
          const { fileType } = detected;

          const title = yield* resolveTitle(
            resolvedPath,
            detected,
            options.title,
          );
          const visualsMode = configuredVisualsMode(appConfig, options);
          const processResult = yield* Effect.either(
            processDocument(resolvedPath, detected, { visualsMode, title }),
          );
          if (processResult._tag === "Left") {
            yield* Effect.logDebug(
              `${fileType} extraction failed for ${resolvedPath}: ${processResult.left}`,
            );
            return yield* Effect.fail(processResult.left);
          }
          const { pageCount, chunks } = processResult.right;

          if (chunks.length === 0) {
            return yield* new DocumentNotFoundError({
              query: `No text content extracted from ${fileType}`,
            });
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
              maxImageBytes: visualsConfig.maxImageBytes,
              maxImagesPerDocument: visualsConfig.maxImagesPerDocument,
            },
          };

          const doc = new Document({
            id,
            title,
            path: resolvedPath,
            addedAt: options.addedAt ?? new Date(),
            pageCount,
            sizeBytes: initialFingerprint.sizeBytes,
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

          // Generate every embedding before touching the DB. Otherwise a
          // mid-file failure can leave an incomplete vector index.
          const embeddingRecords = yield* generateEmbeddings(
            id,
            chunkRecords,
            true,
          );

          const finalFingerprint = yield* fingerprintSource(resolvedPath);
          yield* assertStableSource(initialFingerprint, finalFingerprint);
          const committedDoc = new Document({
            ...doc,
            sizeBytes: finalFingerprint.sizeBytes,
          });

          // Commit document + chunks + embeddings atomically only after all
          // embeddings have been generated.
          yield* documentIntegrity.replaceDocument(
            committedDoc,
            chunkRecords,
            embeddingRecords,
            finalFingerprint.identity,
            "add",
          );
          yield* maintenance.checkpoint();

          return committedDoc;
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
          const existing =
            yield* documents.getDocumentByPath(resolvedPath);
          if (!existing) {
            return yield* new DocumentNotFoundError({ query: resolvedPath });
          }

          const initialFingerprint = yield* resolveInitialFingerprint(
            resolvedPath,
            options,
          );

          // Check embedding provider before doing any work
          yield* embedProvider.checkHealth();

          const id = existing.id;

          const detected = yield* resolveDetectedSourceType(
            resolvedPath,
            options,
          );
          const { fileType } = detected;

          // Preserve existing title/tags/metadata by default
          const title = options.title ?? existing.title;
          const tags = options.tags ?? existing.tags;
          const baseMetadata: Record<string, unknown> =
            options.metadata ?? existing.metadata ?? {};

          const visualsMode = configuredVisualsMode(appConfig, options);
          const processResult = yield* Effect.either(
            processDocument(resolvedPath, detected, { visualsMode, title }),
          );
          if (processResult._tag === "Left") {
            return yield* Effect.fail(processResult.left);
          }
          const { pageCount, chunks } = processResult.right;

          if (chunks.length === 0) {
            return yield* new DocumentNotFoundError({
              query: `No text content extracted from ${fileType}`,
            });
          }

          // Stamp current chunker metadata (always overwrite)
          const chunker = buildChunkerMetadata(fileType, config);
          const mergedMetadata: Record<string, unknown> = {
            ...baseMetadata,
            chunker,
            visuals: {
              enabled: visualsMode !== "disabled",
              version: 1,
              maxImageBytes: visualsConfig.maxImageBytes,
              maxImagesPerDocument: visualsConfig.maxImagesPerDocument,
            },
          };

          const doc = new Document({
            id,
            title,
            path: resolvedPath,
            addedAt: options.addedAt ?? existing.addedAt,
            pageCount,
            sizeBytes: initialFingerprint.sizeBytes,
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
          const embeddingRecords = yield* generateEmbeddings(
            id,
            chunkRecords,
            false,
          );

          const finalFingerprint = yield* fingerprintSource(resolvedPath);
          yield* assertStableSource(initialFingerprint, finalFingerprint);
          const committedDoc = new Document({
            ...doc,
            sizeBytes: finalFingerprint.sizeBytes,
          });

          // Atomic DB replacement
          yield* documentIntegrity.replaceDocument(
            committedDoc,
            chunkRecords,
            embeddingRecords,
            finalFingerprint.identity,
            "refresh",
          );
          yield* maintenance.checkpoint();

          return (yield* documents.getDocument(id)) ?? committedDoc;
        }),

    };
  });

export type DocumentIngestionService = Effect.Effect.Success<
  ReturnType<typeof makeDocumentIngestionService>
>;

export class DocumentIngestion extends Context.Tag("DocumentIngestion")<
  DocumentIngestion,
  DocumentIngestionService
>() {}

export function makeDocumentIngestion(config: Config) {
  return Layer.effect(DocumentIngestion, makeDocumentIngestionService(config));
}
