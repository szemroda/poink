import type { Document, DocumentFileType, LibraryConfig } from "./types.js";

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
  // v2: paragraph-preserving normalization + hyphenation fix
  pdf: { id: "pdf-extractor:paragraphs-v2", version: 2 },
  // v1: section-aware markdown parsing + placeholder-preserving chunking
  markdown: { id: "markdown-extractor:sections+placeholders-v1", version: 1 },
  // v1: mammoth raw-text extraction + paragraph-preserving chunking
  docx: { id: "office-extractor:docx-raw-text-v1", version: 1 },
  // v1: OpenDocument content.xml/fodt XML text extraction + paragraph-preserving chunking
  odt: { id: "office-extractor:odt-content-xml-v1", version: 1 },
};

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
  config: Pick<LibraryConfig, "chunkSize" | "chunkOverlap">,
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
  config: Pick<LibraryConfig, "chunkSize" | "chunkOverlap">,
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
