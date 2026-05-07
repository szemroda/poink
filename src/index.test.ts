import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { PDFLibrary } from "./index.js";
import { AddOptions, OllamaError } from "./types.js";
import { Database } from "./services/Database.js";
import { EmbeddingProvider } from "./services/EmbeddingProvider.js";
import { MarkdownExtractor } from "./services/MarkdownExtractor.js";
import { PDFExtractor } from "./services/PDFExtractor.js";
import { OfficeExtractor } from "./services/OfficeExtractor.js";
import { DEFAULT_QUEUE_CONFIG } from "./services/EmbeddingQueue.js";

describe("PDFLibrary.add", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not persist a new document when embedding fails after an earlier batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdf-brain-add-"));
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

    const database = {
      addDocument: () =>
        Effect.sync(() => {
          persistenceCalls.push("addDocument");
        }),
      getDocument: () => Effect.succeed(null),
      getDocumentByPath: () => Effect.succeed(null),
      listDocuments: () => Effect.succeed([]),
      deleteDocument: () => Effect.void,
      updateTags: () => Effect.void,
      addChunks: () =>
        Effect.sync(() => {
          persistenceCalls.push("addChunks");
        }),
      getChunk: () => Effect.succeed(null),
      listChunksByDocument: () => Effect.succeed([]),
      addEmbeddings: () =>
        Effect.sync(() => {
          persistenceCalls.push("addEmbeddings");
        }),
      replaceDocument: (
        _doc: unknown,
        chunksArg: unknown[],
        embeddingsArg: unknown[],
      ) =>
        Effect.sync(() => {
          persistenceCalls.push(
            `replaceDocument:${chunksArg.length}:${embeddingsArg.length}`,
          );
        }),
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
      checkpoint: () =>
        Effect.sync(() => {
          persistenceCalls.push("checkpoint");
        }),
      dumpDataDir: () => Effect.succeed(new Blob()),
      streamEmbeddings: async function* () {},
      bulkInsertClusterAssignments: () => Effect.void,
    };

    const embeddingProvider = {
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

    const markdownExtractor = {
      extractFrontmatter: () => Effect.succeed({}),
      extract: () =>
        Effect.succeed({ frontmatter: {}, sections: [], sectionCount: 0 }),
      process: () => Effect.succeed({ pageCount: 1, chunks }),
    };

    const unusedPdfExtractor = {
      extract: () => Effect.die("PDF extractor should not be used"),
      process: () => Effect.die("PDF extractor should not be used"),
    };

    const unusedOfficeExtractor = {
      extract: () => Effect.die("Office extractor should not be used"),
      process: () => Effect.die("Office extractor should not be used"),
    };

    const deps = Layer.mergeAll(
      Layer.succeed(Database, database as any),
      Layer.succeed(EmbeddingProvider, embeddingProvider as any),
      Layer.succeed(MarkdownExtractor, markdownExtractor as any),
      Layer.succeed(PDFExtractor, unusedPdfExtractor as any),
      Layer.succeed(OfficeExtractor, unusedOfficeExtractor as any),
    );

    const program = Effect.gen(function* () {
      const library = yield* PDFLibrary;
      return yield* library.add(docPath, new AddOptions({ title: "Doc" }));
    });

    const result = await Effect.runPromise(
      Effect.either(program).pipe(
        Effect.provide(
          PDFLibrary.DefaultWithoutDependencies.pipe(Layer.provide(deps)),
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    expect(embedBatchCalls).toBe(2);
    expect(persistenceCalls).toEqual([]);
  });
});
