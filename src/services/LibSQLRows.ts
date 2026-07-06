import { Schema } from "effect";
import {
  Document,
  DocumentSearchResult,
  PDFChunk,
  type DocumentFileType,
} from "../types.js";
import type { Concept, ConceptAssignment } from "./TaxonomyService.js";
import {
  StorageError,
  type DocumentWithSourceIdentity,
} from "./StorageRepositories.js";
import { decodeStoredSourceIdentity } from "./SourceIntegrity.js";

const SqlInteger = Schema.Union(Schema.Number, Schema.BigIntFromSelf);

const DocumentRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  path: Schema.String,
  added_at: Schema.String,
  page_count: SqlInteger,
  size_bytes: SqlInteger,
  tags: Schema.String,
  metadata: Schema.String,
  file_type: Schema.String,
});

const DocumentWithSourceIdentityRow = Schema.Struct({
  ...DocumentRow.fields,
  source_hash_algorithm: Schema.NullOr(Schema.String),
  source_hash: Schema.NullOr(Schema.String),
});

const ChunkRow = Schema.Struct({
  id: Schema.String,
  doc_id: Schema.String,
  page: SqlInteger,
  chunk_index: SqlInteger,
  content: Schema.String,
  embedding_content: Schema.NullOr(Schema.String),
});

const SearchRow = Schema.Struct({
  chunk_id: Schema.String,
  doc_id: Schema.String,
  title: Schema.String,
  page: SqlInteger,
  chunk_index: SqlInteger,
  content: Schema.String,
  distance: Schema.Number,
});

const FtsSearchRow = Schema.Struct({
  chunk_id: Schema.String,
  doc_id: Schema.String,
  title: Schema.String,
  page: SqlInteger,
  chunk_index: SqlInteger,
  content: Schema.String,
  rank: Schema.Number,
});

const ContextRow = Schema.Struct({
  page: SqlInteger,
  chunk_index: SqlInteger,
  content: Schema.String,
});

const CountRow = Schema.Struct({
  count: SqlInteger,
});

const DocumentCountRow = Schema.Struct({
  doc_id: Schema.String,
  count: SqlInteger,
});

const TableColumnRow = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
});

const MetadataValueRow = Schema.Struct({
  value: Schema.String,
});

const ConceptRow = Schema.Struct({
  id: Schema.String,
  pref_label: Schema.String,
  alt_labels: Schema.String,
  definition: Schema.NullOr(Schema.String),
  created_at: Schema.String,
});

const AssignmentRow = Schema.Struct({
  doc_id: Schema.String,
  concept_id: Schema.String,
  confidence: Schema.Number,
  source: Schema.String,
});

function decode<A, I>(
  schema: Schema.Schema<A, I>,
  row: unknown,
  operation: string,
  rowId?: string,
): A {
  try {
    return Schema.decodeUnknownSync(schema)(row);
  } catch {
    const suffix = rowId ? ` for row ${rowId}` : "";
    throw new StorageError({
      operation,
      reason: `Invalid database row${suffix}: value does not match the expected schema`,
    });
  }
}

function decodeJson<A, I>(
  schema: Schema.Schema<A, I>,
  value: string,
  operation: string,
  table: string,
  rowId: string,
  column: string,
): A {
  try {
    return Schema.decodeUnknownSync(Schema.parseJson(schema))(value);
  } catch {
    throw new StorageError({
      operation,
      reason: `Invalid ${table}.${column} JSON for row ${rowId}`,
    });
  }
}

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function isDocumentFileType(value: string): value is DocumentFileType {
  return (
    value === "pdf" ||
    value === "markdown" ||
    value === "docx" ||
    value === "odt" ||
    value === "txt"
  );
}

export function decodeDocumentRow(
  row: unknown,
  operation: string,
): Document {
  const decoded = decode(DocumentRow, row, operation);
  return documentFromDecodedRow(decoded, operation);
}

export function decodeDocumentWithSourceIdentityRow(
  row: unknown,
  operation: string,
): DocumentWithSourceIdentity {
  const decoded = decode(DocumentWithSourceIdentityRow, row, operation);
  return {
    document: documentFromDecodedRow(decoded, operation),
    sourceIdentity: decodeStoredSourceIdentity(
      decoded.source_hash_algorithm,
      decoded.source_hash,
    ),
  };
}

function documentFromDecodedRow(
  decoded: Schema.Schema.Type<typeof DocumentRow>,
  operation: string,
): Document {
  const addedAt = new Date(decoded.added_at);
  if (Number.isNaN(addedAt.getTime())) {
    throw new StorageError({
      operation,
      reason: `Invalid documents.added_at for row ${decoded.id}`,
    });
  }
  if (!isDocumentFileType(decoded.file_type)) {
    throw new StorageError({
      operation,
      reason: `Invalid documents.file_type for row ${decoded.id}`,
    });
  }

  return new Document({
    id: decoded.id,
    title: decoded.title,
    path: decoded.path,
    addedAt,
    pageCount: toNumber(decoded.page_count),
    sizeBytes: toNumber(decoded.size_bytes),
    tags: decodeJson(
      Schema.Array(Schema.String),
      decoded.tags,
      operation,
      "documents",
      decoded.id,
      "tags",
    ),
    metadata: decodeJson(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      decoded.metadata,
      operation,
      "documents",
      decoded.id,
      "metadata",
    ),
    fileType: decoded.file_type,
  });
}

export function decodeChunkRow(row: unknown, operation: string): PDFChunk {
  const decoded = decode(ChunkRow, row, operation);
  return new PDFChunk({
    id: decoded.id,
    docId: decoded.doc_id,
    page: toNumber(decoded.page),
    chunkIndex: toNumber(decoded.chunk_index),
    content: decoded.content,
    embeddingContent: decoded.embedding_content ?? undefined,
  });
}

export function decodeVectorSearchRow(
  row: unknown,
  operation: string,
): DocumentSearchResult {
  const decoded = decode(SearchRow, row, operation);
  const score = 1 - decoded.distance / 2;
  return new DocumentSearchResult({
    chunkId: decoded.chunk_id,
    docId: decoded.doc_id,
    title: decoded.title,
    page: toNumber(decoded.page),
    chunkIndex: toNumber(decoded.chunk_index),
    content: decoded.content,
    score,
    rawScore: score,
    scoreType: "cosine_similarity",
    vectorScore: score,
    matchType: "vector",
    entityType: "document",
  });
}

export function decodeFtsSearchRow(
  row: unknown,
  operation: string,
): DocumentSearchResult {
  const decoded = decode(FtsSearchRow, row, operation);
  const absoluteRank = Math.abs(decoded.rank);
  return new DocumentSearchResult({
    chunkId: decoded.chunk_id,
    docId: decoded.doc_id,
    title: decoded.title,
    page: toNumber(decoded.page),
    chunkIndex: toNumber(decoded.chunk_index),
    content: decoded.content,
    score: absoluteRank / (1 + absoluteRank),
    rawScore: decoded.rank,
    scoreType: "fts_rank",
    ftsRank: decoded.rank,
    matchType: "fts",
    entityType: "document",
  });
}

export function decodeContextRow(
  row: unknown,
  operation: string,
): { page: number; chunkIndex: number; content: string } {
  const decoded = decode(ContextRow, row, operation);
  return {
    page: toNumber(decoded.page),
    chunkIndex: toNumber(decoded.chunk_index),
    content: decoded.content,
  };
}

export function decodeCountRow(row: unknown, operation: string): number {
  return toNumber(decode(CountRow, row, operation).count);
}

export function decodeDocumentCountRow(
  row: unknown,
  operation: string,
): { docId: string; count: number } {
  const decoded = decode(DocumentCountRow, row, operation);
  return { docId: decoded.doc_id, count: toNumber(decoded.count) };
}

export function decodeTableColumn(
  row: unknown,
  operation: string,
): { name: string; type: string } {
  return decode(TableColumnRow, row, operation);
}

export function decodeMetadataValue(
  row: unknown,
  operation: string,
): string {
  return decode(MetadataValueRow, row, operation).value;
}

export function decodeConceptRow(row: unknown, operation: string): Concept {
  const decoded = decode(ConceptRow, row, operation);
  const createdAt = new Date(decoded.created_at);
  if (Number.isNaN(createdAt.getTime())) {
    throw new StorageError({
      operation,
      reason: `Invalid concepts.created_at for row ${decoded.id}`,
    });
  }
  return {
    id: decoded.id,
    prefLabel: decoded.pref_label,
    altLabels: [
      ...decodeJson(
        Schema.Array(Schema.String),
        decoded.alt_labels,
        operation,
        "concepts",
        decoded.id,
        "alt_labels",
      ),
    ],
    definition: decoded.definition ?? undefined,
    createdAt,
  };
}

export function decodeAssignmentRow(
  row: unknown,
  operation: string,
): ConceptAssignment {
  const decoded = decode(AssignmentRow, row, operation);
  return {
    docId: decoded.doc_id,
    conceptId: decoded.concept_id,
    confidence: decoded.confidence,
    source: decoded.source,
  };
}
