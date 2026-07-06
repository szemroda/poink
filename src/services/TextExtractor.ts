import { Context, Effect, Layer, Schema } from "effect";
import { existsSync, readFileSync, statSync } from "node:fs";
import { assertValidChunking, chunkNormalizedText } from "../chunking.js";
import { resolveUserPath } from "../pathUtils.js";
import { LibraryConfig } from "../types.js";
import { MAX_TEXT_SOURCE_BYTES } from "./SourceFileLimits.js";

export class TextNotFoundError extends Schema.TaggedError<TextNotFoundError>()(
  "TextNotFoundError",
  { path: Schema.String },
) {}

export class TextExtractionError extends Schema.TaggedError<TextExtractionError>()(
  "TextExtractionError",
  { path: Schema.String, reason: Schema.String },
) {}

export interface ProcessedTextChunk {
  page: number;
  chunkIndex: number;
  content: string;
}

interface ProcessedText {
  pageCount: number;
  chunks: ProcessedTextChunk[];
}

export class TextExtractor extends Context.Tag("TextExtractor")<
  TextExtractor,
  {
    readonly process: (
      path: string,
    ) => Effect.Effect<
      ProcessedText,
      TextExtractionError | TextNotFoundError
    >;
  }
>() {}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  } catch {
    throw new TextExtractionError({
      path,
      reason: "Plain text source must be valid UTF-8",
    });
  }
}

export function normalizePlainText(input: string): string {
  const withoutBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  return withoutBom
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping null bytes
    .replace(/\x00/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readTextContent(
  path: string,
): Effect.Effect<string, TextExtractionError | TextNotFoundError> {
  const resolvedPath = resolveUserPath(path);
  if (!existsSync(resolvedPath)) {
    return Effect.fail(new TextNotFoundError({ path: resolvedPath }));
  }

  return Effect.try({
    try: () => {
      const sourceStat = statSync(resolvedPath);
      if (sourceStat.size > MAX_TEXT_SOURCE_BYTES) {
        throw new TextExtractionError({
          path: resolvedPath,
          reason: `Plain text source exceeds max size (${sourceStat.size} bytes > ${MAX_TEXT_SOURCE_BYTES} bytes)`,
        });
      }
      return normalizePlainText(
        decodeUtf8(readFileSync(resolvedPath), resolvedPath),
      );
    },
    catch: (error) =>
      error instanceof TextExtractionError
        ? error
        : new TextExtractionError({
            path: resolvedPath,
            reason: String(error),
          }),
  });
}

function chunkText(
  text: string,
  config: LibraryConfig,
): ProcessedTextChunk[] {
  assertValidChunking(config.chunkSize, config.chunkOverlap);
  return chunkNormalizedText(
    text,
    config.chunkSize,
    config.chunkOverlap,
  ).map((content, chunkIndex) => ({
    page: 1,
    chunkIndex,
    content,
  }));
}

export function makeTextExtractor(config: LibraryConfig) {
  return Layer.succeed(TextExtractor, {
    process: (path: string) =>
      Effect.map(readTextContent(path), (content) => ({
        pageCount: 1,
        chunks: chunkText(content, config),
      })),
  });
}

export const TextExtractorLive = Layer.unwrapEffect(
  Effect.sync(() => makeTextExtractor(LibraryConfig.fromEnv())),
);
