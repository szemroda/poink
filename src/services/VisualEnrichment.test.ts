import { afterEach, describe, expect, test, vi } from "vitest";
import { Context, Effect, Either, Layer } from "effect";
import { Config } from "../types.js";
import { restoreEnvSnapshot, snapshotEnv } from "../testUtils.js";
import { OfficeExtractor } from "./OfficeExtractor.js";
import { PDFExtractor } from "./PDFExtractor.js";
import {
  buildVisualChunkContent,
  filterVisualImages,
  type ExtractedDocumentImage,
  makeVisualEnrichment,
  VisualEnrichment,
  type VisualEnrichmentOptions,
} from "./VisualEnrichment.js";

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "A concise visual description." })),
}));

const { generateText } = await import("ai");
const mockedGenerateText = vi.mocked(generateText);

const envSnapshot = snapshotEnv(["POINK_VISUAL_CONCURRENCY"]);

afterEach(() => {
  // Restores the default mock implementation as well as clearing calls.
  vi.resetAllMocks();
  restoreEnvSnapshot(envSnapshot);
});

const VISUALS_CONFIG = new Config({
  ...Config.Default,
  ingest: {
    ...Config.Default.ingest,
    visuals: { enabled: true, maxImageBytes: "5mb", maxImagesPerDocument: 100 },
  },
});

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

/** Runs enrichment for a PDF whose extractor yields `images`. */
function enrichPdf(
  images: ExtractedDocumentImage[],
  options: VisualEnrichmentOptions,
) {
  const unused = () => Effect.die("unused");
  const pdfExtractor: Context.Tag.Service<typeof PDFExtractor> = {
    extract: unused,
    extractImages: () => Effect.succeed(images),
    process: unused,
  };
  const officeExtractor: Context.Tag.Service<typeof OfficeExtractor> = {
    extract: unused,
    extractImages: unused,
    process: unused,
  };
  const layer = makeVisualEnrichment(VISUALS_CONFIG).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PDFExtractor, pdfExtractor),
        Layer.succeed(OfficeExtractor, officeExtractor),
      ),
    ),
  );

  return Effect.runPromise(
    VisualEnrichment.pipe(
      Effect.flatMap((visuals) =>
        visuals.enrichDocument(
          "doc.pdf",
          { sourceFormat: "pdf", fileType: "pdf" },
          options,
        ),
      ),
      Effect.either,
      Effect.provide(layer),
    ),
  );
}

describe("visual helpers", () => {
  test("filterVisualImages dedupes hashes, skips oversized images, and caps per document", () => {
    const retained = filterVisualImages(
      [
        image({ hash: "a", byteSize: 100 }),
        image({ hash: "a", byteSize: 100 }),
        image({ hash: "b", byteSize: 2_000 }),
        image({ hash: "c", byteSize: 100 }),
        image({ hash: "d", byteSize: 100 }),
      ],
      { maxImageBytes: 1_000, maxImagesPerDocument: 2 },
    );

    expect(retained.map((item) => item.hash)).toEqual(["a", "c"]);
  });

  test("buildVisualChunkContent renders searchable visual metadata", () => {
    const content = buildVisualChunkContent(
      image({ altText: "Revenue by segment" }),
      "A bar chart compares segment revenue.",
    );

    expect(content).toBe(
      [
        "Visual: Page 2, image 1",
        "Alt text: Revenue by segment",
        "Content type: image/png",
        "Dimensions: 100x80",
        "",
        "Description:",
        "A bar chart compares segment revenue.",
      ].join("\n"),
    );
  });
});

describe("VisualEnrichment", () => {
  test("describes retained PDF images with a multimodal model message", async () => {
    const result = await enrichPdf([image({ altText: "Diagram" })], {
      mode: "explicit",
      title: "Doc",
    });

    expect(Either.getOrThrow(result)).toEqual([
      {
        page: 2,
        content: expect.stringContaining("A concise visual description."),
      },
    ]);
    expect(mockedGenerateText.mock.calls[0]?.[0]).toMatchObject({
      abortSignal: expect.any(AbortSignal),
      maxRetries: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: expect.stringContaining("Alt text: Diagram") },
            { type: "image", mediaType: "image/png" },
          ],
        },
      ],
    });
  });

  test("describes images concurrently while preserving chunk order", async () => {
    process.env.POINK_VISUAL_CONCURRENCY = "2";
    let active = 0;
    let maxActive = 0;
    mockedGenerateText.mockImplementation(async (request) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const user = request.messages?.[0];
      const content =
        user?.role === "user" && Array.isArray(user.content) ? user.content : [];
      const prompt = content[0]?.type === "text" ? content[0].text : "";
      const visualIndex = Number(prompt.match(/image (\d+)/)?.[1] ?? "0");
      // The first image finishes last, so ordering must not follow completion.
      await new Promise((resolve) =>
        setTimeout(resolve, visualIndex === 1 ? 20 : 5),
      );
      active--;
      return { text: `Description ${visualIndex}` } as never;
    });

    const result = await enrichPdf(
      [
        image({ hash: "a", visualIndex: 1 }),
        image({ hash: "b", visualIndex: 2 }),
        image({ hash: "c", visualIndex: 3 }),
      ],
      { mode: "explicit" },
    );

    expect(maxActive).toBe(2);
    expect(Either.getOrThrow(result)).toEqual([
      { page: 2, content: expect.stringContaining("Description 1") },
      { page: 2, content: expect.stringContaining("Description 2") },
      { page: 2, content: expect.stringContaining("Description 3") },
    ]);
  });

  test("config mode skips model failures without failing text ingest", async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error("text-only model"));

    const result = await enrichPdf([image()], { mode: "config" });

    expect(Either.getOrThrow(result)).toEqual([]);
  });

  test("explicit mode fails on model failures", async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error("text-only model"));

    const result = await enrichPdf([image()], { mode: "explicit" });

    expect(result).toMatchObject({
      _tag: "Left",
      left: { message: expect.stringContaining("vision-capable") },
    });
  });
});
