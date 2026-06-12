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
import { Database } from "./Database.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import { MarkdownExtractor } from "./MarkdownExtractor.js";
import { PDFExtractor } from "./PDFExtractor.js";
import { OfficeExtractor } from "./OfficeExtractor.js";
import { VisualEnrichment } from "./VisualEnrichment.js";
import { DEFAULT_QUEUE_CONFIG } from "./EmbeddingQueue.js";

type DatabaseService = Context.Tag.Service<typeof Database>;
type EmbeddingProviderService = Context.Tag.Service<typeof EmbeddingProvider>;
type MarkdownExtractorService = Context.Tag.Service<typeof MarkdownExtractor>;
type PDFExtractorService = Context.Tag.Service<typeof PDFExtractor>;
type OfficeExtractorService = Context.Tag.Service<typeof OfficeExtractor>;
type VisualEnrichmentService = Context.Tag.Service<typeof VisualEnrichment>;
type ReplacementChunk = Parameters<DatabaseService["replaceDocument"]>[1][number];
type ReplacementEmbedding =
  Parameters<DatabaseService["replaceDocument"]>[2][number];

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
    dumpDataDir: () => Effect.succeed(new Blob()),
    streamEmbeddings: async function* (_batchSize: number) {},
    bulkInsertClusterAssignments: () => Effect.void,
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

describe("DocumentIngestion.add", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

    const deps = Layer.mergeAll(
      Layer.succeed(Database, database),
      Layer.succeed(EmbeddingProvider, embeddingProvider),
      Layer.succeed(MarkdownExtractor, markdownExtractor),
      Layer.succeed(PDFExtractor, pdfExtractor),
      Layer.succeed(OfficeExtractor, officeExtractor),
      Layer.succeed(VisualEnrichment, visualEnrichment),
    );

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

    const deps = Layer.mergeAll(
      Layer.succeed(Database, database),
      Layer.succeed(EmbeddingProvider, embeddingProvider),
      Layer.succeed(MarkdownExtractor, markdownExtractor),
      Layer.succeed(PDFExtractor, unusedPDFExtractor()),
      Layer.succeed(OfficeExtractor, unusedOfficeExtractor()),
      Layer.succeed(VisualEnrichment, visualEnrichment),
    );

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

    const deps = Layer.mergeAll(
      Layer.succeed(Database, database),
      Layer.succeed(EmbeddingProvider, embeddingProvider),
      Layer.succeed(MarkdownExtractor, markdownExtractor),
      Layer.succeed(PDFExtractor, unusedPDFExtractor()),
      Layer.succeed(OfficeExtractor, unusedOfficeExtractor()),
      Layer.succeed(VisualEnrichment, visualEnrichment),
    );

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
      Layer.succeed(Database, database),
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
