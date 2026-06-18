import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context, Effect, Layer } from "effect";
import {
  DocumentIngestion,
  makeDocumentIngestion,
} from "./DocumentIngestion.js";
import {
  SemanticLibrary,
  makeSemanticLibrary,
} from "./SemanticLibrary.js";
import {
  AddOptions,
  Config,
  Document,
  OllamaError,
} from "../types.js";
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
type VisualEnrichmentService = Context.Tag.Service<typeof VisualEnrichment>;
type SourceFileTypeDetectorService = Context.Tag.Service<
  typeof SourceFileTypeDetector
>;
type ReplacementChunk = Parameters<DatabaseService["replaceDocument"]>[1][number];
type ReplacementEmbedding =
  Parameters<DatabaseService["replaceDocument"]>[2][number];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

function unusedPDFExtractor(): PDFExtractorService {
  return {
    extract: () => Effect.die("PDF extractor should not be used"),
    extractImages: () => Effect.die("PDF extractor should not be used"),
    process: () => Effect.die("PDF extractor should not be used"),
  };
}

function unusedOfficeExtractor(): OfficeExtractorService {
  return {
    extract: () => Effect.die("Office extractor should not be used"),
    extractImages: () => Effect.die("Office extractor should not be used"),
    process: () => Effect.die("Office extractor should not be used"),
  };
}

function makeIngestionDependencies(services: {
  database: DatabaseService;
  embeddingProvider: EmbeddingProviderService;
  markdownExtractor: MarkdownExtractorService;
  pdfExtractor: PDFExtractorService;
  officeExtractor: OfficeExtractorService;
  visualEnrichment: VisualEnrichmentService;
  sourceFileTypeDetector?: SourceFileTypeDetectorService;
}) {
  const sourceFileTypeDetector = services.sourceFileTypeDetector
    ? Layer.succeed(SourceFileTypeDetector, services.sourceFileTypeDetector)
    : SourceFileTypeDetectorLive;
  return Layer.mergeAll(
    Layer.succeed(DocumentRepository, services.database),
    Layer.succeed(DocumentIntegrityRepository, services.database),
    Layer.succeed(SearchRepository, services.database),
    Layer.succeed(LibraryMaintenance, services.database),
    Layer.succeed(EmbeddingProvider, services.embeddingProvider),
    Layer.succeed(MarkdownExtractor, services.markdownExtractor),
    Layer.succeed(PDFExtractor, services.pdfExtractor),
    Layer.succeed(OfficeExtractor, services.officeExtractor),
    Layer.succeed(VisualEnrichment, services.visualEnrichment),
    sourceFileTypeDetector,
  );
}

function successfulEmbeddingProvider(): EmbeddingProviderService {
  return {
    provider: "ollama",
    checkHealth: () => Effect.void,
    embed: () => Effect.succeed([1, 0, 0]),
    embedBatch: (texts) =>
      Effect.succeed(texts.map(() => [1, 0, 0])),
  };
}

function migrationDocument(
  path: string,
  fileType: Document["fileType"],
): Document {
  return new Document({
    id: "doc-1",
    title: "Preserved title",
    path,
    addedAt: new Date("2024-01-02T03:04:05.000Z"),
    pageCount: 9,
    sizeBytes: 12,
    tags: ["preserved"],
    fileType,
    metadata: {
      owner: "user",
      chunker: { id: "old", version: 1 },
      visuals: { enabled: true, version: 0 },
    },
  });
}

function migrationExtractors(
  onProcessed: (sourceFormat: DetectedSourceType["sourceFormat"]) => void,
): {
  markdown: MarkdownExtractorService;
  pdf: PDFExtractorService;
  office: OfficeExtractorService;
} {
  return {
    markdown: {
      extractFrontmatter: () => Effect.succeed({}),
      extract: () =>
        Effect.succeed({ frontmatter: {}, sections: [], sectionCount: 0 }),
      process: () => {
        onProcessed("markdown-text");
        return Effect.succeed({
          pageCount: 1,
          frontmatter: {},
          chunks: [{ page: 1, chunkIndex: 0, content: "markdown" }],
        });
      },
    },
    pdf: {
      extract: () => Effect.die("PDF extract should not be used"),
      extractImages: () => Effect.succeed([]),
      process: () => {
        onProcessed("pdf");
        return Effect.succeed({
          pageCount: 2,
          chunks: [{ page: 1, chunkIndex: 0, content: "pdf" }],
        });
      },
    },
    office: {
      extract: () => Effect.die("Office extract should not be used"),
      extractImages: () => Effect.succeed([]),
      process: (_path, sourceFormat) => {
        onProcessed(sourceFormat);
        return Effect.succeed({
          pageCount: 3,
          chunks: [{ page: 1, chunkIndex: 0, content: sourceFormat }],
        });
      },
    },
  };
}

describe("DocumentIngestion.add", () => {
  test("does not persist a new document when embedding fails after an earlier batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poink-add-"));
    tempDirs.push(dir);
    const docPath = join(dir, "doc.md");
    writeFileSync(docPath, "# Doc\n\ncontent\n");

    const persistenceCalls: string[] = [];
    let embedBatchCalls = 0;

    const chunks = Array.from(
      { length: DEFAULT_QUEUE_CONFIG.batchSize + 1 },
      (_, i) => ({
        page: 1,
        chunkIndex: i,
        content: `chunk ${i}`,
      }),
    );

    const database = makeDatabase({
      replaceDocument: (
        _doc,
        chunksArg,
        embeddingsArg,
      ) =>
        Effect.sync(() => {
          persistenceCalls.push(
            `replaceDocument:${chunksArg.length}:${embeddingsArg.length}`,
          );
        }),
      checkpoint: () =>
        Effect.sync(() => {
          persistenceCalls.push("checkpoint");
        }),
    });

    const embeddingProvider: EmbeddingProviderService = {
      provider: "ollama" as const,
      checkHealth: () => Effect.void,
      embed: () => Effect.succeed([1, 0, 0]),
      embedBatch: (texts: string[]) => {
        embedBatchCalls++;
        if (embedBatchCalls === 2) {
          return Effect.fail(
            new OllamaError({ reason: "simulated second batch failure" }),
          );
        }
        return Effect.succeed(texts.map(() => [1, 0, 0]));
      },
    };

    const markdownExtractor: MarkdownExtractorService = {
      extractFrontmatter: () => Effect.succeed({}),
      extract: () =>
        Effect.succeed({ frontmatter: {}, sections: [], sectionCount: 0 }),
      process: () => Effect.succeed({ pageCount: 1, chunks, frontmatter: {} }),
    };

    const pdfExtractor = unusedPDFExtractor();
    const officeExtractor = unusedOfficeExtractor();
    const visualEnrichment: VisualEnrichmentService = {
      enrichDocument: () => Effect.succeed([]),
    };

    const deps = makeIngestionDependencies({
      database,
      embeddingProvider,
      markdownExtractor,
      pdfExtractor,
      officeExtractor,
      visualEnrichment,
    });

    const program = Effect.gen(function* () {
      const library = yield* DocumentIngestion;
      return yield* library.add(docPath, new AddOptions({ title: "Doc" }));
    });

    const result = await Effect.runPromise(
      Effect.either(program).pipe(
        Effect.provide(
          makeDocumentIngestion(Config.Default).pipe(Layer.provide(deps)),
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    expect(embedBatchCalls).toBe(2);
    expect(persistenceCalls).toEqual([]);
  });

  test("does not persist when the source changes before the final hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poink-add-change-"));
    tempDirs.push(dir);
    const docPath = join(dir, "doc.md");
    writeFileSync(docPath, "# Doc\n\noriginal\n");

    let persisted = false;
    const database = makeDatabase({
      replaceDocument: () =>
        Effect.sync(() => {
          persisted = true;
        }),
    });
    const embeddingProvider: EmbeddingProviderService = {
      provider: "ollama" as const,
      checkHealth: () => Effect.void,
      embed: () => Effect.succeed([1, 0, 0]),
      embedBatch: (texts: string[]) =>
        Effect.sync(() => {
          writeFileSync(docPath, "# Doc\n\nchanged\n");
          return texts.map(() => [1, 0, 0]);
        }),
    };
    const markdownExtractor: MarkdownExtractorService = {
      extractFrontmatter: () => Effect.succeed({}),
      extract: () =>
        Effect.succeed({ frontmatter: {}, sections: [], sectionCount: 0 }),
      process: () =>
        Effect.succeed({
          pageCount: 1,
          frontmatter: {},
          chunks: [{ page: 1, chunkIndex: 0, content: "original" }],
        }),
    };
    const deps = makeIngestionDependencies({
      database,
      embeddingProvider,
      markdownExtractor,
      pdfExtractor: unusedPDFExtractor(),
      officeExtractor: unusedOfficeExtractor(),
      visualEnrichment: {
        enrichDocument: () => Effect.succeed([]),
      },
    });

    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const library = yield* DocumentIngestion;
          return yield* library.add(
            docPath,
            new AddOptions({ title: "Doc" }),
          );
        }),
      ).pipe(
        Effect.provide(
          makeDocumentIngestion(Config.Default).pipe(Layer.provide(deps)),
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SOURCE_CHANGED_DURING_INGESTION",
      });
    }
    expect(persisted).toBe(false);
  });

  test("embeds enriched chunk text while preserving display content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poink-embed-content-"));
    tempDirs.push(dir);
    const docPath = join(dir, "doc.md");
    writeFileSync(docPath, "# Doc\n\ncontent\n");

    let embeddedTexts: string[] = [];
    let persistedChunks: ReplacementChunk[] = [];

    const database = makeDatabase({
      replaceDocument: (_doc, chunksArg) =>
        Effect.sync(() => {
          persistedChunks = chunksArg;
        }),
    });

    const embeddingProvider: EmbeddingProviderService = {
      provider: "ollama" as const,
      checkHealth: () => Effect.void,
      embed: () => Effect.succeed([1, 0, 0]),
      embedBatch: (texts: string[]) =>
        Effect.sync(() => {
          embeddedTexts = texts;
          return texts.map(() => [1, 0, 0]);
        }),
    };

    const markdownExtractor: MarkdownExtractorService = {
      extractFrontmatter: () => Effect.succeed({}),
      extract: () =>
        Effect.succeed({ frontmatter: {}, sections: [], sectionCount: 0 }),
      process: () =>
        Effect.succeed({
          pageCount: 1,
          frontmatter: {},
          chunks: [
            {
              page: 1,
              chunkIndex: 0,
              content:
                "# Section\n\n| Name | Value |\n| --- | --- |\n| Accuracy | High |",
            },
          ],
        }),
    };

    const visualEnrichment: VisualEnrichmentService = {
      enrichDocument: () => Effect.succeed([]),
    };

    const deps = makeIngestionDependencies({
      database,
      embeddingProvider,
      markdownExtractor,
      pdfExtractor: unusedPDFExtractor(),
      officeExtractor: unusedOfficeExtractor(),
      visualEnrichment,
    });

    const program = Effect.gen(function* () {
      const library = yield* DocumentIngestion;
      return yield* library.add(docPath, new AddOptions({ title: "Doc" }));
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          makeDocumentIngestion(Config.Default).pipe(Layer.provide(deps)),
        ),
      ),
    );

    expect(persistedChunks[0].content).toContain("| Name | Value |");
    expect(persistedChunks[0].embeddingContent).toContain("Document: Doc");
    expect(persistedChunks[0].embeddingContent).toContain("Section: Section");
    expect(persistedChunks[0].embeddingContent).toContain(
      "Columns: Name | Value",
    );
    expect(persistedChunks[0].embeddingContent).toContain(
      "Row 1: Name=Accuracy; Value=High",
    );
    expect(embeddedTexts[0]).toBe(persistedChunks[0].embeddingContent);
  });

  test("appends visual chunks when visual enrichment is enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poink-visual-chunks-"));
    tempDirs.push(dir);
    const docPath = join(dir, "doc.md");
    writeFileSync(docPath, "# Doc\n\ncontent\n");

    let embeddedTexts: string[] = [];
    let persistedChunks: ReplacementChunk[] = [];

    const database = makeDatabase({
      replaceDocument: (_doc, chunksArg) =>
        Effect.sync(() => {
          persistedChunks = chunksArg;
        }),
    });

    const embeddingProvider: EmbeddingProviderService = {
      provider: "ollama" as const,
      checkHealth: () => Effect.void,
      embed: () => Effect.succeed([1, 0, 0]),
      embedBatch: (texts: string[]) =>
        Effect.sync(() => {
          embeddedTexts = texts;
          return texts.map(() => [1, 0, 0]);
        }),
    };

    const markdownExtractor: MarkdownExtractorService = {
      extractFrontmatter: () => Effect.succeed({}),
      extract: () =>
        Effect.succeed({ frontmatter: {}, sections: [], sectionCount: 0 }),
      process: () =>
        Effect.succeed({
          pageCount: 1,
          frontmatter: {},
          chunks: [{ page: 1, chunkIndex: 0, content: "Text chunk" }],
        }),
    };

    const visualEnrichment: VisualEnrichmentService = {
      enrichDocument: () =>
        Effect.succeed([
          {
            page: 1,
            chunkIndex: 0,
            content: "Visual: Page 1, image 1\n\nDescription:\nA diagram.",
          },
        ]),
    };

    const deps = makeIngestionDependencies({
      database,
      embeddingProvider,
      markdownExtractor,
      pdfExtractor: unusedPDFExtractor(),
      officeExtractor: unusedOfficeExtractor(),
      visualEnrichment,
    });

    const program = Effect.gen(function* () {
      const library = yield* DocumentIngestion;
      return yield* library.add(
        docPath,
        new AddOptions({ title: "Doc", visuals: true }),
      );
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          makeDocumentIngestion(Config.Default).pipe(Layer.provide(deps)),
        ),
      ),
    );

    expect(persistedChunks).toHaveLength(2);
    expect(persistedChunks[1].content).toContain("Visual: Page 1, image 1");
    expect(embeddedTexts[1]).toContain("A diagram.");
  });

  test("reindex uses stored embedding content when available", async () => {
    const embeddedTexts: string[][] = [];
    const addEmbeddingsCalls: ReplacementEmbedding[][] = [];
    const doc = new Document({
      id: "doc-1",
      title: "Doc",
      path: "doc.md",
      addedAt: new Date(),
      pageCount: 1,
      sizeBytes: 10,
      tags: [],
      fileType: "markdown",
      metadata: {},
    });

    const database = makeDatabase({
      getDocument: () => Effect.succeed(doc),
      listChunksByDocument: () =>
        Effect.succeed([
          {
            id: "chunk-1",
            docId: "doc-1",
            page: 1,
            chunkIndex: 0,
            content: "Display text",
            embeddingContent: "Stored embedding text",
          },
        ]),
      addEmbeddings: (items) =>
        Effect.sync(() => {
          addEmbeddingsCalls.push(items);
        }),
    });

    const embeddingProvider: EmbeddingProviderService = {
      provider: "ollama" as const,
      checkHealth: () => Effect.void,
      embed: () => Effect.succeed([1, 0, 0]),
      embedBatch: (texts: string[]) =>
        Effect.sync(() => {
          embeddedTexts.push(texts);
          return texts.map(() => [1, 0, 0]);
        }),
    };

    const deps = Layer.mergeAll(
      Layer.succeed(DocumentRepository, database),
      Layer.succeed(SearchRepository, database),
      Layer.succeed(LibraryMaintenance, database),
      Layer.succeed(EmbeddingProvider, embeddingProvider),
    );

    const program = Effect.gen(function* () {
      const library = yield* SemanticLibrary;
      return yield* library.reindexEmbeddings("doc-1");
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          makeSemanticLibrary(Config.Default).pipe(Layer.provide(deps)),
        ),
      ),
    );

    expect(embeddedTexts).toEqual([["Stored embedding text"]]);
    expect(addEmbeddingsCalls[0]).toHaveLength(1);
  });
});

describe("DocumentIngestion.replace source type migration", () => {
  const storedTypes = ["pdf", "markdown", "docx", "odt"] as const;
  const detectedTypes = [
    { sourceFormat: "pdf", fileType: "pdf" },
    { sourceFormat: "markdown-text", fileType: "markdown" },
    { sourceFormat: "docx-package", fileType: "docx" },
    { sourceFormat: "odt-package", fileType: "odt" },
    { sourceFormat: "odt-flat-xml", fileType: "odt" },
  ] as const satisfies readonly DetectedSourceType[];
  const migrations = storedTypes.flatMap((storedType) =>
    detectedTypes.map((detected) => ({
      storedType,
      detected,
      name: `${storedType} -> ${detected.sourceFormat}`,
    })),
  );

  test.each(migrations)(
    "migrates $name using the supplied authoritative result",
    async ({ storedType, detected }) => {
      const dir = mkdtempSync(join(tmpdir(), "poink-migration-"));
      tempDirs.push(dir);
      const docPath = join(dir, "source.bin");
      writeFileSync(docPath, "stable source bytes");

      const existing = migrationDocument(docPath, storedType);
      let committed: Document | undefined;
      let processedBy: DetectedSourceType["sourceFormat"] | undefined;
      const database = makeDatabase({
        getDocumentByPath: () => Effect.succeed(existing),
        getDocument: () => Effect.succeed(committed ?? existing),
        replaceDocument: (doc) =>
          Effect.sync(() => {
            committed = doc;
          }),
      });
      const extractors = migrationExtractors((sourceFormat) => {
        processedBy = sourceFormat;
      });
      const deps = makeIngestionDependencies({
        database,
        embeddingProvider: successfulEmbeddingProvider(),
        markdownExtractor: extractors.markdown,
        pdfExtractor: extractors.pdf,
        officeExtractor: extractors.office,
        visualEnrichment: {
          enrichDocument: () => Effect.succeed([]),
        },
        sourceFileTypeDetector: {
          detect: () => Effect.die("Detector should not run"),
        },
      });
      const options = new AddOptions({
        sourceContext: { detectedType: detected },
      });
      const program = Effect.gen(function* () {
        const ingestion = yield* DocumentIngestion;
        yield* ingestion.replace(docPath, options);
        return yield* ingestion.replace(docPath, options);
      });

      await Effect.runPromise(
        program.pipe(
          Effect.provide(
            makeDocumentIngestion(Config.Default).pipe(Layer.provide(deps)),
          ),
        ),
      );

      expect(processedBy).toBe(detected.sourceFormat);
      expect(committed).toMatchObject({
        id: existing.id,
        title: existing.title,
        path: existing.path,
        addedAt: existing.addedAt,
        tags: existing.tags,
        fileType: detected.fileType,
      });
      expect(committed?.metadata).toMatchObject({ owner: "user" });
      expect(committed?.metadata?.chunker).not.toEqual(
        existing.metadata?.chunker,
      );
    },
  );

  test("does not replace existing state when migration embedding fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poink-migration-failure-"));
    tempDirs.push(dir);
    const docPath = join(dir, "source.bin");
    writeFileSync(docPath, "stable source bytes");
    const existing = new Document({
      id: "doc-1",
      title: "Preserved",
      path: docPath,
      addedAt: new Date("2024-01-02T03:04:05.000Z"),
      pageCount: 4,
      sizeBytes: 19,
      tags: ["old"],
      fileType: "pdf",
      metadata: { owner: "user", chunker: { id: "old", version: 1 } },
    });
    let replaceCalls = 0;
    const database = makeDatabase({
      getDocumentByPath: () => Effect.succeed(existing),
      replaceDocument: () =>
        Effect.sync(() => {
          replaceCalls++;
        }),
    });
    const deps = makeIngestionDependencies({
      database,
      embeddingProvider: {
        provider: "ollama",
        checkHealth: () => Effect.void,
        embed: () => Effect.fail(new OllamaError({ reason: "failure" })),
        embedBatch: () =>
          Effect.fail(new OllamaError({ reason: "failure" })),
      },
      markdownExtractor: {
        extractFrontmatter: () => Effect.succeed({}),
        extract: () =>
          Effect.succeed({ frontmatter: {}, sections: [], sectionCount: 0 }),
        process: () =>
          Effect.succeed({
            pageCount: 1,
            frontmatter: {},
            chunks: [{ page: 1, chunkIndex: 0, content: "new content" }],
          }),
      },
      pdfExtractor: unusedPDFExtractor(),
      officeExtractor: unusedOfficeExtractor(),
      visualEnrichment: {
        enrichDocument: () => Effect.succeed([]),
      },
    });
    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const ingestion = yield* DocumentIngestion;
          return yield* ingestion.replace(
            docPath,
            new AddOptions({
              sourceContext: {
                detectedType: {
                  sourceFormat: "markdown-text",
                  fileType: "markdown",
                },
              },
            }),
          );
        }),
      ).pipe(
        Effect.provide(
          makeDocumentIngestion(Config.Default).pipe(Layer.provide(deps)),
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    expect(replaceCalls).toBe(0);
    expect(existing).toMatchObject({
      fileType: "pdf",
      pageCount: 4,
      sizeBytes: 19,
      tags: ["old"],
      metadata: { owner: "user", chunker: { id: "old", version: 1 } },
    });
  });
});
