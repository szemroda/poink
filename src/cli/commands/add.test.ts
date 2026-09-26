import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AddOptions, Config, Document } from "../../types.js";
import {
  AutoTagger,
  type EnrichmentResult,
} from "../../services/AutoTagger.js";
import { OfficeExtractor } from "../../services/OfficeExtractor.js";
import { PDFExtractor } from "../../services/PDFExtractor.js";
import { SourceFileTypeDetectorLive } from "../../services/SourceFileType.js";
import { runAddCommand } from "./add.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const unused = (name: string) => () => Effect.die(`${name} should not be used`);

describe("runAddCommand --enrich", () => {
  test("persists enrichment metadata and assigns concepts to the added document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poink-add-"));
    tempDirs.push(dir);
    const sourcePath = join(dir, "notes.md");
    writeFileSync(sourcePath, "# Notes\n\nbody\n");

    const enrichment: EnrichmentResult = {
      title: "Notes",
      author: "Ada",
      summary: "A summary.",
      documentType: "notes",
      category: "programming",
      tags: ["rust"],
      concepts: ["programming/rust"],
      confidence: 0.9,
      provider: "ollama",
    };
    const added: AddOptions[] = [];
    const assignments: Array<[string, EnrichmentResult]> = [];
    const library = {
      add: (path: string, options: AddOptions = new AddOptions({})) =>
        Effect.sync(() => {
          added.push(options);
          return new Document({
            id: "doc-1",
            title: options.title ?? "Notes",
            path,
            addedAt: new Date(),
            pageCount: 1,
            sizeBytes: 1,
            tags: [...(options.tags ?? [])],
            fileType: "markdown",
            metadata: options.metadata ?? {},
          });
        }),
      stats: () =>
        Effect.succeed({ documents: 1, chunks: 1, embeddings: 1, libraryPath: dir }),
    };
    const services = Layer.mergeAll(
      Layer.succeed(
        AutoTagger,
        AutoTagger.of({
          enrich: () => Effect.succeed(enrichment),
          generateTags: unused("generateTags"),
          assignConcepts: (docId, result) =>
            Effect.sync(() => {
              assignments.push([docId, result]);
              return { assigned: result.concepts, acceptedProposals: 0 };
            }),
        }),
      ),
      Layer.succeed(PDFExtractor, {
        extract: unused("PDF extractor"),
        extractImages: unused("PDF extractor"),
        process: unused("PDF extractor"),
      }),
      Layer.succeed(OfficeExtractor, {
        extract: unused("Office extractor"),
        extractImages: unused("Office extractor"),
        process: unused("Office extractor"),
      }),
      SourceFileTypeDetectorLive,
    );

    await Effect.runPromise(
      runAddCommand(
        ["add", sourcePath],
        {
          format: "json",
          configuredDefaultFormat: "json",
          pretty: false,
          verbose: false,
          logLevel: "error",
          config: Config.Default,
          library,
        },
        { enrich: true },
      ).pipe(Effect.provide(services)),
    );

    expect(added[0]?.metadata).toEqual({
      enrichment: {
        summary: "A summary.",
        author: "Ada",
        documentType: "notes",
        category: "programming",
        provider: "ollama",
        confidence: 0.9,
      },
    });
    expect(assignments).toEqual([["doc-1", enrichment]]);
  });
});
