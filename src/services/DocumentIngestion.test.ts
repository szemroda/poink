import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context, Effect, Either, Layer } from "effect";
import {
  DocumentIngestion,
  makeDocumentIngestion,
  type DocumentIngestionService,
} from "./DocumentIngestion.js";
import { AddOptions, Config, Document, OllamaError } from "../types.js";
import {
  DocumentIntegrityRepository,
  DocumentRepository,
  LibraryMaintenance,
  SearchRepository,
  type DocumentRepositoryService,
  type DocumentIntegrityRepositoryService,
  type LibraryMaintenanceService,
  type SearchRepositoryService,
} from "./StorageRepositories.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import { MarkdownExtractor } from "./MarkdownExtractor.js";
import { PDFExtractor } from "./PDFExtractor.js";
import { OfficeExtractor } from "./OfficeExtractor.js";
import { TextExtractor } from "./TextExtractor.js";
import { VisualEnrichment } from "./VisualEnrichment.js";
import {
  SourceFileTypeDetector,
  SourceFileTypeDetectorLive,
  type DetectedSourceType,
} from "./SourceFileType.js";
import { DEFAULT_QUEUE_CONFIG } from "./EmbeddingQueue.js";

type DatabaseService = DocumentRepositoryService &
  DocumentIntegrityRepositoryService &
  SearchRepositoryService &
  LibraryMaintenanceService;
type EmbeddingProviderService = Context.Tag.Service<typeof EmbeddingProvider>;
type MarkdownExtractorService = Context.Tag.Service<typeof MarkdownExtractor>;
type PDFExtractorService = Context.Tag.Service<typeof PDFExtractor>;
type OfficeExtractorService = Context.Tag.Service<typeof OfficeExtractor>;
type TextExtractorService = Context.Tag.Service<typeof TextExtractor>;
type VisualEnrichmentService = Context.Tag.Service<typeof VisualEnrichment>;
type SourceFileTypeDetectorService = Context.Tag.Service<
  typeof SourceFileTypeDetector
>;
type ReplacementChunk = Parameters<DatabaseService["replaceDocument"]>[1][number];
type ExtractedChunk = { page: number; chunkIndex: number; content: string };

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes `content` to a fresh temp file and returns its path. */
function writeSource(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "poink-ingestion-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

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
    replaceDocument: () => Effect.void,
    getDocumentWithSourceIdentity: () => Effect.succeed(null),
    listDocumentsWithSourceIdentity: () => Effect.succeed([]),
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

/** Embedding provider that records every batch and can fail the Nth one. */
function recordingEmbeddingProvider(
  options: { onBatch?: () => void; failOnBatch?: number } = {},
): { provider: EmbeddingProviderService; batches: string[][] } {
  const batches: string[][] = [];
  return {
    batches,
    provider: {
      provider: "ollama",
      checkHealth: () => Effect.void,
      embed: () => Effect.succeed([1, 0, 0]),
      embedBatch: (texts) =>
        Effect.suspend(() => {
          batches.push(texts);
          options.onBatch?.();
          if (batches.length === options.failOnBatch) {
            return Effect.fail(new OllamaError({ reason: "batch failed" }));
          }
          return Effect.succeed(texts.map(() => [1, 0, 0]));
        }),
    },
  };
}

function markdownExtractorReturning(
  chunks: ExtractedChunk[],
): MarkdownExtractorService {
  return {
    extractFrontmatter: () => Effect.succeed({}),
    extract: () =>
      Effect.succeed({ frontmatter: {}, sections: [], sectionCount: 0 }),
    process: () => Effect.succeed({ pageCount: 1, frontmatter: {}, chunks }),
  };
}

function unused(name: string) {
  return () => Effect.die(`${name} should not be used`);
}

const noVisuals: VisualEnrichmentService = {
  enrichDocument: () => Effect.succeed([]),
};

/**
 * Runs `use` against a DocumentIngestion built from the given fakes. Services
 * that a test does not supply die when touched.
 */
function runIngestion<A, E>(
  services: {
    database: DatabaseService;
    embeddingProvider?: EmbeddingProviderService;
    markdownExtractor?: MarkdownExtractorService;
    pdfExtractor?: PDFExtractorService;
    officeExtractor?: OfficeExtractorService;
    textExtractor?: TextExtractorService;
    visualEnrichment?: VisualEnrichmentService;
    sourceFileTypeDetector?: SourceFileTypeDetectorService;
  },
  use: (ingestion: DocumentIngestionService) => Effect.Effect<A, E>,
): Promise<Either.Either<A, E>> {
  const deps = Layer.mergeAll(
    Layer.succeed(DocumentRepository, services.database),
    Layer.succeed(DocumentIntegrityRepository, services.database),
    Layer.succeed(SearchRepository, services.database),
    Layer.succeed(LibraryMaintenance, services.database),
    Layer.succeed(
      EmbeddingProvider,
      services.embeddingProvider ?? recordingEmbeddingProvider().provider,
    ),
    Layer.succeed(
      MarkdownExtractor,
      services.markdownExtractor ?? {
        extractFrontmatter: unused("Markdown extractor"),
        extract: unused("Markdown extractor"),
        process: unused("Markdown extractor"),
      },
    ),
    Layer.succeed(
      PDFExtractor,
      services.pdfExtractor ?? {
        extract: unused("PDF extractor"),
        extractImages: unused("PDF extractor"),
        process: unused("PDF extractor"),
      },
    ),
    Layer.succeed(
      OfficeExtractor,
      services.officeExtractor ?? {
        extract: unused("Office extractor"),
        extractImages: unused("Office extractor"),
        process: unused("Office extractor"),
      },
    ),
    Layer.succeed(
      TextExtractor,
      services.textExtractor ?? { process: unused("Text extractor") },
    ),
    Layer.succeed(VisualEnrichment, services.visualEnrichment ?? noVisuals),
    services.sourceFileTypeDetector
      ? Layer.succeed(SourceFileTypeDetector, services.sourceFileTypeDetector)
      : SourceFileTypeDetectorLive,
  );
  return Effect.runPromise(
    Effect.either(Effect.flatMap(DocumentIngestion, use)).pipe(
      Effect.provide(
        makeDocumentIngestion(Config.Default).pipe(Layer.provide(deps)),
      ),
    ),
  );
}

function recordingDatabase(overrides: Partial<DatabaseService> = {}) {
  const replaced: Array<{ doc: Document; chunks: ReplacementChunk[] }> = [];
  const database = makeDatabase({
    replaceDocument: (doc, chunks) =>
      Effect.sync(() => {
        replaced.push({ doc, chunks });
      }),
    ...overrides,
  });
  return { database, replaced };
}

describe("DocumentIngestion.add", () => {
  test("does not persist a new document when embedding fails after an earlier batch", async () => {
    const docPath = writeSource("doc.md", "# Doc\n\ncontent\n");
    let checkpoints = 0;
    const { database, replaced } = recordingDatabase({
      checkpoint: () =>
        Effect.sync(() => {
          checkpoints++;
        }),
    });
    const embeddings = recordingEmbeddingProvider({ failOnBatch: 2 });
    const chunks = Array.from(
      { length: DEFAULT_QUEUE_CONFIG.batchSize + 1 },
      (_, i) => ({ page: 1, chunkIndex: i, content: `chunk ${i}` }),
    );

    const result = await runIngestion(
      {
        database,
        embeddingProvider: embeddings.provider,
        markdownExtractor: markdownExtractorReturning(chunks),
      },
      (ingestion) => ingestion.add(docPath, new AddOptions({ title: "Doc" })),
    );

    expect(Either.isLeft(result)).toBe(true);
    expect(embeddings.batches).toHaveLength(2);
    expect(replaced).toEqual([]);
    expect(checkpoints).toBe(0);
  });

  test("does not persist when the source changes before the final hash", async () => {
    const docPath = writeSource("doc.md", "# Doc\n\noriginal\n");
    const { database, replaced } = recordingDatabase();
    const embeddings = recordingEmbeddingProvider({
      onBatch: () => writeFileSync(docPath, "# Doc\n\nchanged\n"),
    });

    const result = await runIngestion(
      {
        database,
        embeddingProvider: embeddings.provider,
        markdownExtractor: markdownExtractorReturning([
          { page: 1, chunkIndex: 0, content: "original" },
        ]),
      },
      (ingestion) => ingestion.add(docPath, new AddOptions({ title: "Doc" })),
    );

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "SOURCE_FILE_CHANGED",
    });
    expect(replaced).toEqual([]);
  });

  test("embeds enriched chunk text while preserving display content", async () => {
    const docPath = writeSource("doc.md", "# Doc\n\ncontent\n");
    const { database, replaced } = recordingDatabase();
    const embeddings = recordingEmbeddingProvider();
    const content =
      "# Section\n\n| Name | Value |\n| --- | --- |\n| Accuracy | High |";

    await runIngestion(
      {
        database,
        embeddingProvider: embeddings.provider,
        markdownExtractor: markdownExtractorReturning([
          { page: 1, chunkIndex: 0, content },
        ]),
      },
      (ingestion) => ingestion.add(docPath, new AddOptions({ title: "Doc" })),
    );

    const embeddingContent = [
      "Document: Doc",
      "Section: Section",
      "Page: 1",
      "",
      content,
      "",
      "Columns: Name | Value",
      "Row 1: Name=Accuracy; Value=High",
    ].join("\n");
    expect(replaced[0]?.chunks).toEqual([
      expect.objectContaining({ content, embeddingContent }),
    ]);
    expect(embeddings.batches).toEqual([[embeddingContent]]);
  });

  test("ingests detected TXT files with txt chunker metadata", async () => {
    const docPath = writeSource(
      "meeting-notes.txt",
      "Unique plain text phrase.",
    );
    const { database, replaced } = recordingDatabase();
    const embeddings = recordingEmbeddingProvider();

    const result = await runIngestion(
      {
        database,
        embeddingProvider: embeddings.provider,
        textExtractor: {
          process: () =>
            Effect.succeed({
              pageCount: 1,
              chunks: [
                { page: 1, chunkIndex: 0, content: "Unique plain text phrase." },
              ],
            }),
        },
      },
      (ingestion) => ingestion.add(docPath),
    );

    expect(Either.getOrThrow(result).title).toBe("meeting-notes");
    const persisted = replaced[0];
    expect(persisted?.doc).toMatchObject({
      fileType: "txt",
      pageCount: 1,
      title: "meeting-notes",
      metadata: {
        chunker: {
          id: "txt-extractor:plain-context-v1",
          version: 1,
          unit: "chars",
        },
      },
    });
    expect(persisted?.chunks[0]?.embeddingContent).toContain(
      "Document: meeting-notes",
    );
    expect(embeddings.batches).toEqual([
      [persisted?.chunks[0]?.embeddingContent],
    ]);
  });

  test("appends visual chunks after text chunks when visual enrichment is enabled", async () => {
    const docPath = writeSource("doc.md", "# Doc\n\ncontent\n");
    const { database, replaced } = recordingDatabase();
    const embeddings = recordingEmbeddingProvider();
    const visual = "Visual: Page 1, image 1\n\nDescription:\nA diagram.";

    await runIngestion(
      {
        database,
        embeddingProvider: embeddings.provider,
        markdownExtractor: markdownExtractorReturning([
          { page: 1, chunkIndex: 0, content: "Text chunk" },
        ]),
        visualEnrichment: {
          enrichDocument: () =>
            Effect.succeed([{ page: 1, chunkIndex: 0, content: visual }]),
        },
      },
      (ingestion) =>
        ingestion.add(docPath, new AddOptions({ title: "Doc", visuals: true })),
    );

    expect(replaced[0]?.chunks).toEqual([
      expect.objectContaining({ chunkIndex: 0, content: "Text chunk" }),
      expect.objectContaining({ chunkIndex: 1, content: visual }),
    ]);
    expect(embeddings.batches[0]?.[1]).toContain("A diagram.");
  });
});

describe("DocumentIngestion.replace source type migration", () => {
  function storedDocument(path: string): Document {
    return new Document({
      id: "doc-1",
      title: "Preserved title",
      path,
      addedAt: new Date("2024-01-02T03:04:05.000Z"),
      pageCount: 9,
      sizeBytes: 12,
      tags: ["preserved"],
      fileType: "pdf",
      metadata: {
        owner: "user",
        chunker: { id: "old", version: 1 },
        visuals: { enabled: true, version: 0 },
      },
    });
  }

  function migrationOptions(detectedType: DetectedSourceType): AddOptions {
    return new AddOptions({ sourceContext: { detectedType } });
  }

  // `replace` never reads the stored file type, so one stored type suffices;
  // what varies is which extractor the supplied detection routes to.
  test.each([
    { sourceFormat: "pdf", fileType: "pdf" },
    { sourceFormat: "markdown-text", fileType: "markdown" },
    { sourceFormat: "plain-text", fileType: "txt" },
    { sourceFormat: "docx-package", fileType: "docx" },
    { sourceFormat: "odt-package", fileType: "odt" },
    { sourceFormat: "odt-flat-xml", fileType: "odt" },
  ] as const satisfies readonly DetectedSourceType[])(
    "migrates to $sourceFormat using the supplied authoritative result",
    async (detected) => {
      const docPath = writeSource("source.bin", "stable source bytes");
      const existing = storedDocument(docPath);
      const { database, replaced } = recordingDatabase({
        getDocumentByPath: () => Effect.succeed(existing),
      });
      let processedBy: DetectedSourceType["sourceFormat"] | undefined;
      const processed = (sourceFormat: DetectedSourceType["sourceFormat"]) => {
        processedBy = sourceFormat;
        return Effect.succeed({
          pageCount: 1,
          chunks: [{ page: 1, chunkIndex: 0, content: sourceFormat }],
        });
      };

      const result = await runIngestion(
        {
          database,
          markdownExtractor: {
            extractFrontmatter: () => Effect.succeed({}),
            extract: unused("Markdown extract"),
            process: () =>
              processed("markdown-text").pipe(
                Effect.map((extracted) => ({ ...extracted, frontmatter: {} })),
              ),
          },
          pdfExtractor: {
            extract: unused("PDF extract"),
            extractImages: () => Effect.succeed([]),
            process: () => processed("pdf"),
          },
          officeExtractor: {
            extract: unused("Office extract"),
            extractImages: () => Effect.succeed([]),
            process: (_path, sourceFormat) => processed(sourceFormat),
          },
          textExtractor: { process: () => processed("plain-text") },
          sourceFileTypeDetector: { detect: unused("Detector") },
        },
        (ingestion) => ingestion.replace(docPath, migrationOptions(detected)),
      );

      expect(Either.isRight(result)).toBe(true);
      expect(processedBy).toBe(detected.sourceFormat);
      const committed = replaced[0]?.doc;
      expect(committed).toMatchObject({
        id: existing.id,
        title: existing.title,
        path: existing.path,
        addedAt: existing.addedAt,
        tags: existing.tags,
        fileType: detected.fileType,
        metadata: { owner: "user" },
      });
      expect(committed?.metadata?.chunker).not.toEqual(
        existing.metadata?.chunker,
      );
    },
  );

  test("does not replace existing state when migration embedding fails", async () => {
    const docPath = writeSource("source.bin", "stable source bytes");
    const { database, replaced } = recordingDatabase({
      getDocumentByPath: () => Effect.succeed(storedDocument(docPath)),
    });

    const result = await runIngestion(
      {
        database,
        embeddingProvider: recordingEmbeddingProvider({ failOnBatch: 1 }).provider,
        markdownExtractor: markdownExtractorReturning([
          { page: 1, chunkIndex: 0, content: "new content" },
        ]),
      },
      (ingestion) =>
        ingestion.replace(
          docPath,
          migrationOptions({
            sourceFormat: "markdown-text",
            fileType: "markdown",
          }),
        ),
    );

    expect(Either.isLeft(result)).toBe(true);
    expect(replaced).toEqual([]);
  });
});
