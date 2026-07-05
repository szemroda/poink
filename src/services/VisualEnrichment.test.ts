import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context, Effect, Layer } from "effect";
import { Config } from "../types.js";
import { OfficeExtractor } from "./OfficeExtractor.js";
import { PDFExtractor } from "./PDFExtractor.js";
import type { DetectedSourceType } from "./SourceFileType.js";
import {
  buildVisualChunkContent,
  filterVisualImages,
  type ExtractedDocumentImage,
  VisualEnrichment,
  makeVisualEnrichment,
} from "./VisualEnrichment.js";
import { loadConfig } from "../types.js";

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "A concise visual description." })),
}));

const { generateText } = await import("ai");
const mockedGenerateText = vi.mocked(generateText);

const ORIGINAL_POINK_CONFIG = process.env.POINK_CONFIG;
const DETECTED_PDF = {
  sourceFormat: "pdf",
  fileType: "pdf",
} satisfies DetectedSourceType;
type PDFExtractorService = Context.Tag.Service<typeof PDFExtractor>;
type OfficeExtractorService = Context.Tag.Service<typeof OfficeExtractor>;

afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_POINK_CONFIG === undefined) {
    delete process.env.POINK_CONFIG;
  } else {
    process.env.POINK_CONFIG = ORIGINAL_POINK_CONFIG;
  }
});

function configureVisuals(
  overrides: Partial<{
    enabled: boolean;
    maxImageBytes: string;
    maxImagesPerDocument: number;
  }> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "poink-visuals-"));
  const configPath = join(dir, "config.json");
  const config = JSON.parse(JSON.stringify(Config.Default));
  config.library.path = join(dir, "library");
  config.ingest.visuals = {
    enabled: true,
    maxImageBytes: "5mb",
    maxImagesPerDocument: 100,
    ...overrides,
  };
  process.env.POINK_CONFIG = configPath;
  writeFileSync(configPath, JSON.stringify(config), "utf-8");
  return dir;
}

function image(
  overrides: Partial<ExtractedDocumentImage> = {},
): ExtractedDocumentImage {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    sourceKind: "pdf",
    page: 2,
    visualIndex: 1,
    contentType: "image/png",
    bytes,
    byteSize: bytes.byteLength,
    width: 100,
    height: 80,
    hash: "hash-1",
    ...overrides,
  };
}

describe("visual filtering", () => {
  test("dedupes hashes, skips oversized images, and caps per document", () => {
    const retained = filterVisualImages(
      [
        image({ hash: "a", byteSize: 100 }),
        image({ hash: "a", byteSize: 100, visualIndex: 2 }),
        image({ hash: "b", byteSize: 2_000, visualIndex: 3 }),
        image({ hash: "c", byteSize: 100, visualIndex: 4 }),
      ],
      { maxImageBytes: 1_000, maxImagesPerDocument: 1 },
    );

    expect(retained.map((item) => item.hash)).toEqual(["a"]);
  });

  test("renders searchable visual chunk content", () => {
    const content = buildVisualChunkContent(
      image({ altText: "Revenue by segment" }),
      "A bar chart compares segment revenue.",
    );

    expect(content).toContain("Visual: Page 2, image 1");
    expect(content).toContain("Alt text: Revenue by segment");
    expect(content).toContain("Dimensions: 100x80");
    expect(content).toContain("Description:");
  });
});

describe("VisualEnrichment", () => {
  test("describes retained PDF images with a multimodal model message", async () => {
    const dir = configureVisuals();
    try {
      const pdfExtractor: PDFExtractorService = {
        extract: () => Effect.die("unused"),
        extractImages: () => Effect.succeed([image({ altText: "Diagram" })]),
        process: () => Effect.die("unused"),
      };
      const officeExtractor: OfficeExtractorService = {
        extract: () => Effect.die("unused"),
        extractImages: () => Effect.succeed([]),
        process: () => Effect.die("unused"),
      };

      const program = Effect.gen(function* () {
        const visuals = yield* VisualEnrichment;
        return yield* visuals.enrichDocument("doc.pdf", DETECTED_PDF, {
          mode: "explicit",
          title: "Doc",
        });
      });

      const chunks = await Effect.runPromise(
        program.pipe(
          Effect.provide(
            makeVisualEnrichment(loadConfig()).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(PDFExtractor, pdfExtractor),
                  Layer.succeed(OfficeExtractor, officeExtractor),
                ),
              ),
            ),
          ),
        ),
      );

      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.content).toContain("A concise visual description.");
      const call = mockedGenerateText.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      const message = call?.messages?.[0];
      expect(message?.role).toBe("user");
      expect(Array.isArray(message?.content)).toBe(true);
      const content = Array.isArray(message?.content) ? message.content : [];
      expect(content[0]?.type).toBe("text");
      expect(content[1]?.type).toBe("image");
      if (content[1]?.type === "image") {
        expect(content[1].mediaType).toBe("image/png");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("config mode skips model failures without failing text ingest", async () => {
    const dir = configureVisuals();
    mockedGenerateText.mockRejectedValueOnce(new Error("text-only model"));
    try {
      const pdfExtractor: PDFExtractorService = {
        extract: () => Effect.die("unused"),
        extractImages: () => Effect.succeed([image()]),
        process: () => Effect.die("unused"),
      };
      const officeExtractor: OfficeExtractorService = {
        extract: () => Effect.die("unused"),
        extractImages: () => Effect.succeed([]),
        process: () => Effect.die("unused"),
      };

      const program = Effect.gen(function* () {
        const visuals = yield* VisualEnrichment;
        return yield* visuals.enrichDocument("doc.pdf", DETECTED_PDF, {
          mode: "config",
        });
      });

      const chunks = await Effect.runPromise(
        program.pipe(
          Effect.provide(
            makeVisualEnrichment(loadConfig()).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(PDFExtractor, pdfExtractor),
                  Layer.succeed(OfficeExtractor, officeExtractor),
                ),
              ),
            ),
          ),
        ),
      );

      expect(chunks).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit mode fails on model failures", async () => {
    const dir = configureVisuals();
    mockedGenerateText.mockRejectedValueOnce(new Error("text-only model"));
    try {
      const pdfExtractor: PDFExtractorService = {
        extract: () => Effect.die("unused"),
        extractImages: () => Effect.succeed([image()]),
        process: () => Effect.die("unused"),
      };
      const officeExtractor: OfficeExtractorService = {
        extract: () => Effect.die("unused"),
        extractImages: () => Effect.succeed([]),
        process: () => Effect.die("unused"),
      };

      const program = Effect.gen(function* () {
        const visuals = yield* VisualEnrichment;
        return yield* visuals.enrichDocument("doc.pdf", DETECTED_PDF, {
          mode: "explicit",
        });
      });

      const result = await Effect.runPromise(
        Effect.either(program).pipe(
          Effect.provide(
            makeVisualEnrichment(loadConfig()).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(PDFExtractor, pdfExtractor),
                  Layer.succeed(OfficeExtractor, officeExtractor),
                ),
              ),
            ),
          ),
        ),
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.message).toContain("vision-capable");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
