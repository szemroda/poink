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

export const CURRENT_CHUNKER: Record<
  DocumentFileType,
  { id: string; version: number }
> = {
  // v5: shared chunking + PDF cleanup/title heuristics + hyperlink/table-aware extraction
  pdf: { id: "pdf-extractor:shared-context-v5", version: 5 },
  // v3: shared chunking + heading ancestry/table preservation + enriched embedding text
  markdown: { id: "markdown-extractor:shared-context-v3", version: 3 },
  // v3: shared chunking + mammoth HTML heading/table sections + enriched embedding text
  docx: { id: "office-extractor:docx-shared-context-v3", version: 3 },
  // v3: shared chunking + OpenDocument heading/table extraction + enriched embedding text
  odt: { id: "office-extractor:odt-shared-context-v3", version: 3 },
};

const SENTENCE_RE = /[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g;

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

    if (para.length > chunkSize) {
      const sentences = para.match(SENTENCE_RE) || [para];
      currentChunk = "";

      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length <= chunkSize) {
          currentChunk += sentence;
          continue;
        }

        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }

        if (sentence.length > chunkSize) {
          for (let i = 0; i < sentence.length; i += chunkSize) {
            chunks.push(sentence.slice(i, i + chunkSize).trim());
          }
          currentChunk = "";
        } else {
          currentChunk = sentence;
        }
      }
    } else {
      currentChunk = para;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return applyAdjacentChunkOverlap(
    chunks.filter((chunk) => chunk.length > 20),
    chunkOverlap,
  );
}

export function inferFileTypeFromPath(path: string): DocumentFileType {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".odt") || lower.endsWith(".fodt")) return "odt";
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
  config: { chunkSize: number; chunkOverlap: number },
): ChunkerMetadata {
  assertValidChunking(config.chunkSize, config.chunkOverlap);
  const base = CURRENT_CHUNKER[fileType];
  return {
    id: base.id,
    version: base.version,
    unit: "chars",
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  };
}

export function parseChunkerMetadata(value: unknown): ChunkerMetadata | null {
  if (!value || typeof value !== "object") return null;
  const v: any = value;

  const id = typeof v.id === "string" ? v.id : null;
  const version = typeof v.version === "number" ? v.version : null;
  const unit = v.unit === "chars" ? ("chars" as const) : null;
  const chunkSize = typeof v.chunkSize === "number" ? v.chunkSize : null;
  const chunkOverlap = typeof v.chunkOverlap === "number" ? v.chunkOverlap : null;

  if (!id || version === null || !unit || chunkSize === null || chunkOverlap === null) {
    return null;
  }

  return { id, version, unit, chunkSize, chunkOverlap };
}

export function getDocChunkerMetadata(doc: Document): ChunkerMetadata | null {
  const meta = doc.metadata;
  if (!meta || typeof meta !== "object") return null;
  const chunker = (meta as any).chunker;
  return parseChunkerMetadata(chunker);
}

export function assessDocChunker(
  doc: Document,
  config: { chunkSize: number; chunkOverlap: number },
): {
  needsRechunk: boolean;
  code:
    | "ok"
    | "missing_metadata"
    | "id_version_mismatch"
    | "config_mismatch"
    | "unit_mismatch";
  reason: string;
  expected: ChunkerMetadata;
  actual: ChunkerMetadata | null;
} {
  const fileType =
    doc.fileType ??
    (doc.path ? inferFileTypeFromPath(doc.path) : ("pdf" as const));
  const expected = buildChunkerMetadata(fileType, config);
  const actual = getDocChunkerMetadata(doc);

  if (!actual) {
    return {
      needsRechunk: true,
      code: "missing_metadata",
      reason: "missing chunker metadata",
      expected,
      actual: null,
    };
  }

  if (actual.id !== expected.id || actual.version !== expected.version) {
    return {
      needsRechunk: true,
      code: "id_version_mismatch",
      reason: `chunker id/version mismatch (${actual.id}@${actual.version} != ${expected.id}@${expected.version})`,
      expected,
      actual,
    };
  }

  if (actual.chunkSize !== expected.chunkSize || actual.chunkOverlap !== expected.chunkOverlap) {
    return {
      needsRechunk: true,
      code: "config_mismatch",
      reason: `chunkSize/chunkOverlap mismatch (${actual.chunkSize}/${actual.chunkOverlap} != ${expected.chunkSize}/${expected.chunkOverlap})`,
      expected,
      actual,
    };
  }

  if (actual.unit !== expected.unit) {
    return {
      needsRechunk: true,
      code: "unit_mismatch",
      reason: `chunk unit mismatch (${actual.unit} != ${expected.unit})`,
      expected,
      actual,
    };
  }

  return { needsRechunk: false, code: "ok", reason: "ok", expected, actual };
}
