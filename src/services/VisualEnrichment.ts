import { generateText } from "ai";
import dedent from "dedent";
import { Context, Effect, Layer } from "effect";
import type { DocumentFileType } from "../types.js";
import { loadConfig, resolveVisualsConfig } from "../types.js";
import {
  describeLanguageModelError,
  getConfiguredLanguageModel,
} from "./AIProvider.js";
import { OfficeExtractor } from "./OfficeExtractor.js";
import { PDFExtractor } from "./PDFExtractor.js";

export type VisualSourceKind = "pdf" | "docx";
export type VisualsMode = "disabled" | "config" | "explicit";

export interface ExtractedDocumentImage {
  sourceKind: VisualSourceKind;
  page: number;
  visualIndex: number;
  contentType: string;
  bytes: Uint8Array;
  byteSize: number;
  width?: number;
  height?: number;
  hash: string;
  resourceName?: string;
  altText?: string;
  context?: string;
}

export interface VisualDescriptionChunk {
  page: number;
  chunkIndex: number;
  content: string;
  embeddingContent?: string;
}

export class VisualEnrichmentError {
  readonly _tag = "VisualEnrichmentError";
  readonly name = "VisualEnrichmentError";

  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}

  toString(): string {
    return this.message;
  }
}

export interface VisualEnrichmentOptions {
  mode: VisualsMode;
  title?: string;
}

export class VisualEnrichment extends Context.Tag("VisualEnrichment")<
  VisualEnrichment,
  {
    readonly enrichDocument: (
      path: string,
      fileType: DocumentFileType,
      options: VisualEnrichmentOptions,
    ) => Effect.Effect<VisualDescriptionChunk[], VisualEnrichmentError>;
  }
>() {}

function visualError(message: string, cause?: unknown): VisualEnrichmentError {
  return new VisualEnrichmentError(message, cause);
}

function describeCause(error: unknown): string {
  if (error instanceof VisualEnrichmentError) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof (error as { reason?: unknown }).reason === "string"
  ) {
    return (error as { reason: string }).reason;
  }
  return String(error);
}

export function filterVisualImages(
  images: readonly ExtractedDocumentImage[],
  options: { maxImageBytes: number; maxImagesPerDocument: number },
): ExtractedDocumentImage[] {
  const seen = new Set<string>();
  const retained: ExtractedDocumentImage[] = [];

  for (const image of images) {
    if (retained.length >= options.maxImagesPerDocument) break;
    if (image.byteSize > options.maxImageBytes) continue;
    if (seen.has(image.hash)) continue;
    seen.add(image.hash);
    retained.push(image);
  }

  return retained;
}

const systemPrompt = dedent`
  Describe this document visual for a searchable personal knowledge library.

  Focus on what is visually present: diagrams, screenshots, charts, labels, relationships, visible numbers, trends, and notable UI or document elements.
  Keep the description concise and useful for text search.
  If text or numbers are unreadable, say so instead of guessing.
`;

export function buildVisualPrompt(
  image: ExtractedDocumentImage,
  options: { title?: string },
): string {
  const location =
    image.sourceKind === "pdf"
      ? `PDF page ${image.page}, image ${image.visualIndex}`
      : `DOCX image ${image.visualIndex}`;
  return dedent`
    Document title: ${options.title ?? "(unknown)"}
    Location: ${location}
    Alt text: ${image.altText ?? "(none)"}
    Surrounding context: ${image.context ?? "(none)"}
  `;
}

export function buildVisualChunkContent(
  image: ExtractedDocumentImage,
  description: string,
): string {
  const header =
    image.sourceKind === "pdf"
      ? `Visual: Page ${image.page}, image ${image.visualIndex}`
      : `Visual: DOCX image ${image.visualIndex}`;
  const details = [
    header,
    image.altText ? `Alt text: ${image.altText}` : null,
    `Content type: ${image.contentType}`,
    image.width && image.height
      ? `Dimensions: ${image.width}x${image.height}`
      : null,
    image.resourceName ? `Resource: ${image.resourceName}` : null,
    "",
    "Description:",
    description.trim(),
  ].filter((line): line is string => line !== null);

  return details.join("\n").trim();
}

async function describeImage(
  image: ExtractedDocumentImage,
  options: { title?: string },
): Promise<string> {
  const config = loadConfig();
  const resolved = getConfiguredLanguageModel(config, "enrichment");
  const result = await generateText({
    model: resolved.model,
    ...(resolved.providerOptions
      ? { providerOptions: resolved.providerOptions }
      : {}),
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildVisualPrompt(image, options) },
          {
            type: "image",
            image: Buffer.from(image.bytes),
            mediaType: image.contentType,
          },
        ],
      },
    ],
  });

  return result.text;
}

export const VisualEnrichmentLive = Layer.effect(
  VisualEnrichment,
  Effect.gen(function* () {
    const pdfExtractor = yield* PDFExtractor;
    const officeExtractor = yield* OfficeExtractor;

    return {
      enrichDocument: (
        path: string,
        fileType: DocumentFileType,
        options: VisualEnrichmentOptions,
      ) => {
        if (options.mode === "disabled") return Effect.succeed([]);

        const program = Effect.gen(function* () {
          const appConfig = loadConfig();
          const visualsConfig = resolveVisualsConfig(appConfig);
          if (!visualsConfig.enabled && options.mode !== "explicit") {
            return [];
          }

          const extracted = yield* (() => {
            if (fileType === "pdf") {
              return pdfExtractor
                .extractImages(path)
                .pipe(
                  Effect.mapError((error) =>
                    visualError(
                      `PDF visual extraction failed: ${describeCause(error)}`,
                      error,
                    ),
                  ),
                );
            }
            if (fileType === "docx") {
              return officeExtractor
                .extractImages(path)
                .pipe(
                  Effect.mapError((error) =>
                    visualError(
                      `DOCX visual extraction failed: ${describeCause(error)}`,
                      error,
                    ),
                  ),
                );
            }
            return Effect.succeed([]);
          })();

          const retained = filterVisualImages(extracted, visualsConfig);
          const chunks: VisualDescriptionChunk[] = [];

          for (const image of retained) {
            const description = yield* Effect.tryPromise({
              try: () => describeImage(image, { title: options.title }),
              catch: (error) =>
                visualError(
                  `Visual enrichment requires a vision-capable models.enrichment model. Current visual description failed: ${describeLanguageModelError(error)}`,
                  error,
                ),
            });
            chunks.push({
              page: image.page,
              chunkIndex: chunks.length,
              content: buildVisualChunkContent(image, description),
            });
          }

          return chunks;
        });

        if (options.mode === "config") {
          return program.pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(
                `Visual enrichment skipped for ${path}: ${describeCause(error)}`,
              ).pipe(Effect.as([])),
            ),
          );
        }

        return program;
      },
    };
  }),
);
