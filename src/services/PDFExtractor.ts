/**
 * PDF Extraction Service
 */

import { Context, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import type { TableArray } from "pdf-parse";
import { getData } from "pdf-parse/worker";
import {
  assertValidChunking,
  chunkNormalizedText,
  preprocessLargeMarkdownTables,
} from "../chunking.js";
import { resolveUserPath } from "../pathUtils.js";
import { fileExists, readFileBytes } from "../runtime.js";
import {
  LibraryConfig,
  PDFExtractionError,
  PDFNotFoundError,
} from "../types.js";
import type { ExtractedDocumentImage } from "./VisualEnrichment.js";

// ============================================================================
// Service Definition
// ============================================================================

export interface ExtractedPage {
  page: number;
  text: string;
}

export interface ExtractedPDF {
  pages: ExtractedPage[];
  pageCount: number;
}

export interface ProcessedChunk {
  page: number;
  chunkIndex: number;
  content: string;
}

export class PDFExtractor extends Context.Tag("PDFExtractor")<
  PDFExtractor,
  {
    readonly extract: (
      path: string,
    ) => Effect.Effect<ExtractedPDF, PDFExtractionError | PDFNotFoundError>;
    readonly extractImages: (
      path: string,
    ) => Effect.Effect<
      ExtractedDocumentImage[],
      PDFExtractionError | PDFNotFoundError
    >;
    readonly process: (
      path: string,
    ) => Effect.Effect<
      { pageCount: number; chunks: ProcessedChunk[] },
      PDFExtractionError | PDFNotFoundError
    >;
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

function resolvePath(path: string): string {
  return resolveUserPath(path);
}

const pdfParseModulePromise = (async () => {
  const { PDFParse } = await import("pdf-parse");
  PDFParse.setWorker(getData());
  return PDFParse;
})();

function normalizeInlineWhitespace(text: string): string {
  return sanitizeText(text).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(value: string): string {
  return normalizeInlineWhitespace(value).replace(/\|/g, "\\|");
}

function renderMarkdownRow(cells: string[]): string {
  return `| ${cells.map(escapeMarkdownTableCell).join(" | ")} |`;
}

function markdownSeparator(width: number): string {
  return renderMarkdownRow([
    "---",
    ...Array.from({ length: Math.max(0, width - 1) }, () => "---:"),
  ]);
}

function normalizeTableRows(rows: TableArray): TableArray {
  const trimmedRows = rows
    .map((row) => row.map((cell) => normalizeInlineWhitespace(cell)))
    .filter((row) => row.some(Boolean));

  if (trimmedRows.length === 0) return [];

  const width = Math.max(...trimmedRows.map((row) => row.length));
  return trimmedRows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
}

export function renderPDFTableAsMarkdown(rows: TableArray): string {
  const normalized = normalizeTableRows(rows);
  if (normalized.length === 0) return "";

  const width = normalized[0]?.length ?? 0;
  return [
    renderMarkdownRow(normalized[0] ?? []),
    markdownSeparator(width),
    ...normalized.slice(1).map(renderMarkdownRow),
  ].join("\n");
}

function isUsablePDFParseTable(rows: TableArray): boolean {
  const normalized = normalizeTableRows(rows);
  if (normalized.length < 2) return false;

  const width = Math.max(...normalized.map((row) => row.length));
  if (width < 2) return false;

  const nonEmptyCells = normalized.flat().filter(Boolean).length;
  return nonEmptyCells >= Math.max(4, normalized.length);
}

function explicitTablesMarkdown(tables: TableArray[]): string {
  const markdownTables = tables
    .filter(isUsablePDFParseTable)
    .map(renderPDFTableAsMarkdown)
    .filter(Boolean);

  if (markdownTables.length === 0) return "";

  return [
    "## Detected PDF tables",
    ...markdownTables.map((table, index) => `Table ${index + 1}\n\n${table}`),
  ].join("\n\n");
}

export function enhancePDFPageText(
  text: string,
  explicitTables: TableArray[] = [],
): string {
  const explicit = explicitTablesMarkdown(explicitTables);
  return [text.trim(), explicit].filter(Boolean).join("\n\n").trim();
}

async function extractFromResolvedPath(path: string): Promise<ExtractedPDF> {
  // Local buffers are more reliable than URL loading for pdf-parse.
  const data = await readFileBytes(path);
  const PDFParse = await pdfParseModulePromise;
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getText({
      pageJoiner: "",
      parseHyperlinks: true,
      lineEnforce: true,
      cellSeparator: "\t",
    });
    const tableResult = await parser.getTable().catch(() => null);
    const tablesByPage = new Map<number, TableArray[]>(
      (tableResult?.pages ?? []).map((page) => [
        page.num,
        page.tables,
      ]),
    );

    return {
      pageCount: result.total,
      pages: result.pages.map(({ num, text }) => ({
        page: num,
        text: enhancePDFPageText(text, tablesByPage.get(num) ?? []),
      })),
    };
  } finally {
    await parser.destroy();
  }
}

async function extractImagesFromResolvedPath(
  path: string,
): Promise<ExtractedDocumentImage[]> {
  const data = await readFileBytes(path);
  const PDFParse = await pdfParseModulePromise;
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getImage({
      imageThreshold: 80,
      imageDataUrl: false,
      imageBuffer: true,
    });

    const images: ExtractedDocumentImage[] = [];
    for (const page of result.pages ?? []) {
      const pageNumber = page.pageNumber;
      for (const image of page.images ?? []) {
        const bytes = image.data;
        const hash = createHash("sha256").update(bytes).digest("hex");
        images.push({
          sourceKind: "pdf",
          page: pageNumber,
          visualIndex: images.length + 1,
          contentType: "image/png",
          bytes,
          byteSize: bytes.byteLength,
          width: image.width,
          height: image.height,
          hash,
          resourceName: image.name,
          context:
            typeof image.kind === "number"
              ? `PDF image kind: ${image.kind}`
              : undefined,
        });
      }
    }
    return images;
  } finally {
    await parser.destroy();
  }
}

/**
 * Sanitize text by removing null bytes that crash PostgreSQL TEXT columns
 */
export function sanitizeText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping null bytes
  return text.replace(/\x00/g, "");
}

function normalizePdfLine(line: string): string {
  return sanitizeText(line)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isPageNumberLine(line: string): boolean {
  return /^(?:page\s*)?\d+(?:\s*(?:\/|of)\s*\d+)?$/i.test(line.trim());
}

function splitPdfLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function contentLineIndices(lines: string[]): number[] {
  return lines
    .map((line, index) => ({ index, normalized: normalizePdfLine(line) }))
    .filter(({ normalized }) => normalized)
    .map(({ index }) => index);
}

function pageEdgeLineIndices(nonBlankIndices: number[]): Set<number> {
  const topEdgeCount = nonBlankIndices.length <= 5 ? 1 : 3;
  const bottomEdgeCount = nonBlankIndices.length <= 5 ? 2 : 3;

  return new Set([
    ...nonBlankIndices.slice(0, topEdgeCount),
    ...nonBlankIndices.slice(-bottomEdgeCount),
  ]);
}

function pageArtifactCandidates(text: string): Set<string> {
  const lines = splitPdfLines(text);
  const edgeIndices = pageEdgeLineIndices(contentLineIndices(lines));
  const candidates = new Set<string>();

  for (const index of edgeIndices) {
    const line = normalizePdfLine(lines[index] ?? "");
    if (line && line.length <= 120) {
      candidates.add(line);
    }
  }

  return candidates;
}

function repeatedPageArtifactLines(pages: ExtractedPage[]): Set<string> {
  if (pages.length < 2) return new Set();

  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  const counts = new Map<string, number>();
  const repeated = new Set<string>();

  for (const { text } of pages) {
    for (const line of pageArtifactCandidates(text)) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  for (const [line, count] of counts) {
    if (count >= threshold) {
      repeated.add(line);
    }
  }

  return repeated;
}

export function cleanPDFPageArtifacts(pages: ExtractedPage[]): ExtractedPage[] {
  const repeated = repeatedPageArtifactLines(pages);

  return pages.map(({ page, text }) => {
    const lines = splitPdfLines(text);
    const nonBlankIndices = contentLineIndices(lines);
    const edgeLineIndices = pageEdgeLineIndices(nonBlankIndices);
    const firstContentLine = nonBlankIndices[0];
    const lastContentLine = nonBlankIndices[nonBlankIndices.length - 1];
    const cleaned = lines
      .filter((line, index) => {
        const normalized = normalizePdfLine(line);
        if (!normalized) return true;
        const repeatedArtifact =
          edgeLineIndices.has(index) && repeated.has(normalized);
        const pageNumberArtifact =
          (index === firstContentLine || index === lastContentLine) &&
          isPageNumberLine(line);
        return !repeatedArtifact && !pageNumberArtifact;
      })
      .join("\n");

    return { page, text: cleaned };
  });
}

function isLikelyPDFSectionTitle(line: string): boolean {
  const trimmed = line.trim();
  if (
    trimmed.length < 3 ||
    trimmed.length > 120 ||
    trimmed.startsWith("|") ||
    isPageNumberLine(trimmed) ||
    /[.!?:;]$/.test(trimmed)
  ) {
    return false;
  }

  const words = trimmed.split(/\s+/);
  if (words.length > 10) return false;

  const letters = trimmed.replace(/[^A-Za-z]/g, "");
  const upper = trimmed.replace(/[^A-Z]/g, "");
  const isMostlyUpper = letters.length >= 3 && upper.length / letters.length > 0.75;
  const isTitleCase = words.every((word) => {
    const cleaned = word.replace(/[^A-Za-z]/g, "");
    return !cleaned || /^[A-Z]/.test(cleaned);
  });

  return isMostlyUpper || isTitleCase;
}

function preservePDFSectionTitles(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (isLikelyPDFSectionTitle(trimmed)) {
      if (output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      output.push(`# ${trimmed}`);
      output.push("");
    } else {
      output.push(line);
    }
  }

  return output.join("\n");
}

function isMarkdownTableBlock(text: string): boolean {
  return /^\|[^\n]+\|\n\|[-:\s|]+\|/m.test(text.trim());
}

/**
 * Chunk text with intelligent splitting
 */
export function chunkText(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  assertValidChunking(chunkSize, chunkOverlap);

  // Clean up text - sanitize first, then normalize while preserving paragraph structure.
  //
  // IMPORTANT: Do NOT collapse `\s+` here. In PDFs, newlines often carry meaning
  // (paragraph breaks). Collapsing all whitespace nukes paragraph boundaries and
  // makes chunking far worse.
  const cleaned = (() => {
    let t = sanitizeText(text);

    // Normalize newlines from various PDF extractors/platforms.
    t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\f/g, "\n");

    // Normalize non-breaking spaces.
    t = t.replace(/\u00a0/g, " ");

    // Remove common hyphenation artifacts at line breaks: "inter-\nnational"
    t = t.replace(/([A-Za-z])-\n([A-Za-z])/g, "$1$2");

    // Trim trailing/leading whitespace per line.
    t = t
      .split("\n")
      .map((line) => line.trim())
      .join("\n");

    // Collapse long blank runs.
    t = t.replace(/\n{3,}/g, "\n\n");
    t = preservePDFSectionTitles(t);

    // Reconstruct paragraphs:
    // - split on blank lines
    // - within normal paragraphs, join wrapped lines with spaces
    // - preserve Markdown table row newlines from Office/Markdown-derived text
    const paragraphs = t
      .split(/\n\s*\n+/)
      .map((p) => {
        const normalized = p
          .split("\n")
          .map((line) => line.trim())
          .join("\n")
          .trim();
        if (isMarkdownTableBlock(normalized)) {
          return normalized.replace(/[ \t]+/g, " ");
        }
        return normalized.replace(/\n+/g, " ").replace(/[ \t]+/g, " ").trim();
      })
      .filter(Boolean);

    return preprocessLargeMarkdownTables(
      paragraphs.join("\n\n").trim(),
      Math.floor(chunkSize * 0.8),
    );
  })();

  return chunkNormalizedText(cleaned, chunkSize, chunkOverlap);
}

export function makePDFExtractor(config: LibraryConfig) {
  return Layer.effect(
    PDFExtractor,
    Effect.gen(function* () {
    return {
      extract: (path: string) =>
        Effect.gen(function* () {
          // Resolve path
          const resolvedPath = resolvePath(path);

          if (!fileExists(resolvedPath)) {
            return yield* Effect.fail(
              new PDFNotFoundError({ path: resolvedPath }),
            );
          }

          const result = yield* Effect.tryPromise({
            try: async () => extractFromResolvedPath(resolvedPath),
            catch: (e) =>
              new PDFExtractionError({ path: resolvedPath, reason: String(e) }),
          });

          return result;
        }),

      extractImages: (path: string) =>
        Effect.gen(function* () {
          const resolvedPath = resolvePath(path);

          if (!fileExists(resolvedPath)) {
            return yield* Effect.fail(
              new PDFNotFoundError({ path: resolvedPath }),
            );
          }

          return yield* Effect.tryPromise({
            try: async () => extractImagesFromResolvedPath(resolvedPath),
            catch: (e) =>
              new PDFExtractionError({ path: resolvedPath, reason: String(e) }),
          });
        }),

      process: (path: string) =>
        Effect.gen(function* () {
          const resolvedPath = resolvePath(path);

          if (!fileExists(resolvedPath)) {
            return yield* Effect.fail(
              new PDFNotFoundError({ path: resolvedPath }),
            );
          }

          const extracted = yield* Effect.tryPromise({
            try: async () => {
              return extractFromResolvedPath(resolvedPath);
            },
            catch: (e) =>
              new PDFExtractionError({ path: resolvedPath, reason: String(e) }),
          });

          const allChunks: ProcessedChunk[] = [];

          for (const { page, text } of cleanPDFPageArtifacts(extracted.pages)) {
            const pageChunks = chunkText(
              text,
              config.chunkSize,
              config.chunkOverlap,
            );
            pageChunks.forEach((content, chunkIndex) => {
              allChunks.push({ page, chunkIndex, content });
            });
          }

          return { pageCount: extracted.pageCount, chunks: allChunks };
        }),
    };
    }),
  );
}

export const PDFExtractorLive = Layer.unwrapEffect(
  Effect.sync(() => makePDFExtractor(LibraryConfig.fromEnv())),
);
