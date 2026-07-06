import type { Document, DocumentFileType } from "./types.js";

export type ChunkerMetadata = {
  /** Stable identifier for the chunking algorithm implementation */
  id: string;
  /** Monotonic version for breaking chunker changes */
  version: number;
  /** Unit used for chunk sizing and overlap */
  unit: "chars";
  chunkSize: number;
  chunkOverlap: number;
};

type ChunkingConfig = {
  chunkSize: number;
  chunkOverlap: number;
};

type ChunkerIdentity = Pick<ChunkerMetadata, "id" | "version">;

type ChunkerAssessmentCode =
  | "ok"
  | "missing_metadata"
  | "id_version_mismatch"
  | "config_mismatch"
  | "unit_mismatch";

type ChunkerAssessment = {
  needsRechunk: boolean;
  code: ChunkerAssessmentCode;
  reason: string;
  expected: ChunkerMetadata;
  actual: ChunkerMetadata | null;
};

const CHUNK_UNIT = "chars" as const;
const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;
const ODT_EXTENSIONS = [".odt", ".fodt"] as const;
const TXT_EXTENSIONS = [".txt"] as const;

export const CURRENT_CHUNKER: Record<DocumentFileType, ChunkerIdentity> = {
  // v7: shared chunking preserves short trailing chunks + optional visual enrichment chunks
  pdf: { id: "pdf-extractor:shared-context-v7", version: 7 },
  // v4: shared chunking preserves short trailing chunks + heading ancestry/table preservation + enriched embedding text
  markdown: { id: "markdown-extractor:shared-context-v4", version: 4 },
  // v5: shared chunking preserves short trailing chunks + optional visual enrichment chunks
  docx: { id: "office-extractor:docx-shared-context-v5", version: 5 },
  // v4: shared chunking preserves short trailing chunks + OpenDocument heading/table extraction + enriched embedding text
  odt: { id: "office-extractor:odt-shared-context-v4", version: 4 },
  // v1: plain UTF-8 text normalization + shared chunking
  txt: { id: "txt-extractor:plain-context-v1", version: 1 },
};

const SENTENCE_RE = /[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function suffixAtWordBoundary(text: string, targetChars: number): string {
  if (text.length <= targetChars) return text.trim();

  const start = Math.max(0, text.length - targetChars);
  const suffix = text.slice(start);
  const boundary = suffix.search(/\s/);

  if (start === 0 || boundary < 0 || boundary > targetChars * 0.25) {
    return suffix.trim();
  }

  return suffix.slice(boundary).trim();
}

function hardSplitText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize).trim());
  }
  return chunks;
}

function hasExtension(path: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => path.endsWith(extension));
}

function chunkerAssessment(
  expected: ChunkerMetadata,
  actual: ChunkerMetadata | null,
  code: Exclude<ChunkerAssessmentCode, "ok">,
  reason: string,
): ChunkerAssessment {
  return {
    needsRechunk: true,
    code,
    reason,
    expected,
    actual,
  };
}

export function buildChunkOverlapPrefix(
  text: string,
  targetChars: number,
): string {
  if (targetChars <= 0) return "";

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= targetChars) return normalized;

  const sentences = normalized.match(SENTENCE_RE)?.map((s) => s.trim()) ?? [];
  if (sentences.length === 0) {
    return suffixAtWordBoundary(normalized, targetChars);
  }

  const selected: string[] = [];
  let length = 0;

  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i];
    if (!sentence) continue;

    const nextLength = length + sentence.length + (selected.length > 0 ? 1 : 0);
    if (selected.length > 0 && nextLength > targetChars * 1.5) break;

    selected.unshift(sentence);
    length = nextLength;
    if (length >= targetChars) break;
  }

  const overlap = selected.join(" ").trim();
  return overlap.length > targetChars * 2
    ? suffixAtWordBoundary(overlap, targetChars)
    : overlap;
}

export function applyAdjacentChunkOverlap(
  chunks: string[],
  chunkOverlap: number,
): string[] {
  if (chunkOverlap <= 0 || chunks.length <= 1) return chunks;

  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;

    const prefix = buildChunkOverlapPrefix(chunks[index - 1], chunkOverlap);
    return prefix ? `${prefix}\n\n${chunk}` : chunk;
  });
}

export function splitMarkdownTable(table: string, maxSize: number): string[] {
  const lines = table.trim().split("\n");
  if (lines.length < 3) return [table];

  const header = lines[0];
  const separator = lines[1];
  const rows = lines.slice(2);
  const headerOverhead = header.length + separator.length + 2;
  const effectiveMax = maxSize - headerOverhead;
  const chunks: string[] = [];
  let currentRows: string[] = [];
  let currentLength = 0;

  for (const row of rows) {
    const rowLength = row.length + 1;

    if (currentLength + rowLength > effectiveMax && currentRows.length > 0) {
      chunks.push([header, separator, ...currentRows].join("\n"));
      currentRows = [];
      currentLength = 0;
    }

    currentRows.push(row);
    currentLength += rowLength;
  }

  if (currentRows.length > 0) {
    chunks.push([header, separator, ...currentRows].join("\n"));
  }

  return chunks;
}

export function preprocessLargeMarkdownTables(
  text: string,
  maxTableSize: number,
): string {
  return text.replace(
    /(\|[^\n]+\|\n\|[-:\s|]+\|\n(?:\|[^\n]+\|\n?)+)/g,
    (match) =>
      match.length <= maxTableSize
        ? match
        : splitMarkdownTable(match, maxTableSize).join("\n\n"),
  );
}

function chunkOversizedParagraph(
  paragraph: string,
  chunkSize: number,
  chunks: string[],
): string {
  const sentences = paragraph.match(SENTENCE_RE) ?? [paragraph];
  let currentChunk = "";

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length <= chunkSize) {
      currentChunk += sentence;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    if (sentence.length <= chunkSize) {
      currentChunk = sentence;
      continue;
    }

    chunks.push(...hardSplitText(sentence, chunkSize));
    currentChunk = "";
  }

  return currentChunk;
}

export function chunkNormalizedText(
  cleaned: string,
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  assertValidChunking(chunkSize, chunkOverlap);
  if (cleaned.length <= chunkSize) {
    return cleaned ? [cleaned] : [];
  }

  const chunks: string[] = [];
  const paragraphs = cleaned.split(/\n\n+/);
  let currentChunk = "";

  for (const para of paragraphs) {
    if (currentChunk.length + para.length + 2 <= chunkSize) {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    if (para.length <= chunkSize) {
      currentChunk = para;
      continue;
    }

    currentChunk = chunkOversizedParagraph(para, chunkSize, chunks);
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return applyAdjacentChunkOverlap(
    chunks.filter((chunk) => chunk.length > 0),
    chunkOverlap,
  );
}

export function inferFileTypeFromPath(path: string): DocumentFileType {
  const lower = path.toLowerCase();
  if (hasExtension(lower, MARKDOWN_EXTENSIONS)) return "markdown";
  if (lower.endsWith(".docx")) return "docx";
  if (hasExtension(lower, ODT_EXTENSIONS)) return "odt";
  if (hasExtension(lower, TXT_EXTENSIONS)) return "txt";
  return "pdf";
}

export function assertValidChunking(
  chunkSize: number,
  chunkOverlap: number,
): void {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSize must be > 0, got ${chunkSize}`);
  }
  if (!Number.isFinite(chunkOverlap) || chunkOverlap < 0) {
    throw new Error(`chunkOverlap must be >= 0, got ${chunkOverlap}`);
  }
  if (chunkOverlap >= chunkSize) {
    throw new Error(
      `chunkOverlap (${chunkOverlap}) must be smaller than chunkSize (${chunkSize})`,
    );
  }
}

export function buildChunkerMetadata(
  fileType: DocumentFileType,
  config: ChunkingConfig,
): ChunkerMetadata {
  assertValidChunking(config.chunkSize, config.chunkOverlap);
  const base = CURRENT_CHUNKER[fileType];
  return {
    id: base.id,
    version: base.version,
    unit: CHUNK_UNIT,
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  };
}

export function parseChunkerMetadata(value: unknown): ChunkerMetadata | null {
  if (!isRecord(value)) return null;

  const { id, version, unit, chunkSize, chunkOverlap } = value;
  if (
    typeof id !== "string" ||
    !id ||
    typeof version !== "number" ||
    unit !== CHUNK_UNIT ||
    typeof chunkSize !== "number" ||
    typeof chunkOverlap !== "number"
  ) {
    return null;
  }

  return { id, version, unit, chunkSize, chunkOverlap };
}

export function getDocChunkerMetadata(doc: Document): ChunkerMetadata | null {
  return parseChunkerMetadata(doc.metadata?.chunker);
}

export function assessDocChunker(
  doc: Document,
  config: ChunkingConfig,
): ChunkerAssessment {
  const fileType =
    doc.fileType ?? (doc.path ? inferFileTypeFromPath(doc.path) : "pdf");
  const expected = buildChunkerMetadata(fileType, config);
  const actual = getDocChunkerMetadata(doc);

  if (!actual) {
    return chunkerAssessment(
      expected,
      null,
      "missing_metadata",
      "missing chunker metadata",
    );
  }

  if (actual.id !== expected.id || actual.version !== expected.version) {
    return chunkerAssessment(
      expected,
      actual,
      "id_version_mismatch",
      `chunker id/version mismatch (${actual.id}@${actual.version} != ${expected.id}@${expected.version})`,
    );
  }

  if (
    actual.chunkSize !== expected.chunkSize ||
    actual.chunkOverlap !== expected.chunkOverlap
  ) {
    return chunkerAssessment(
      expected,
      actual,
      "config_mismatch",
      `chunkSize/chunkOverlap mismatch (${actual.chunkSize}/${actual.chunkOverlap} != ${expected.chunkSize}/${expected.chunkOverlap})`,
    );
  }

  if (actual.unit !== expected.unit) {
    return chunkerAssessment(
      expected,
      actual,
      "unit_mismatch",
      `chunk unit mismatch (${actual.unit} != ${expected.unit})`,
    );
  }

  return { needsRechunk: false, code: "ok", reason: "ok", expected, actual };
}
