import type { InStatement, InValue } from "@libsql/client";
import { Effect, Layer } from "effect";
import type { Document } from "../types.js";
import {
  DocumentIntegrityRepository,
  DocumentRepository,
  LibraryMaintenance,
  SearchRepository,
  VectorRebuildRepository,
  storageEffect,
  type ChunkInput,
  type DocumentRepositoryService,
  type DocumentIntegrityRepositoryService,
  type EmbeddingInput,
  type LibraryMaintenanceService,
  type SearchRepositoryService,
} from "./StorageRepositories.js";
import { LibSQLClient, type LibSQLClientService } from "./LibSQLClient.js";
import {
  decodeChunkRow,
  decodeContextRow,
  decodeCountRow,
  decodeDocumentCountRow,
  decodeDocumentRow,
  decodeDocumentWithSourceIdentityRow,
  decodeFtsSearchRow,
  decodeVectorSearchRow,
} from "./LibSQLRows.js";
import { tableExists } from "./LibSQLSchema.js";
import { makeVectorRebuildRepository } from "./LibSQLVectorRebuild.js";
import type { SourceIdentity } from "./SourceIntegrity.js";

const CONTEXT_QUERY_LIMIT = 20;
const CONTEXT_LENGTH_TOLERANCE = 1.2;
const DOCUMENT_COUNT_BATCH_SIZE = 500;
const DOCUMENT_SELECT_SQL = "SELECT * FROM documents";
const DOCUMENT_TAG_FILTER_SQL =
  "json_array_length(tags) > 0 AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)";

function documentInsertStatement(
  doc: Document,
  sourceIdentity: SourceIdentity,
): InStatement {
  return {
    sql: `INSERT INTO documents
            (id, title, path, added_at, page_count, size_bytes, tags, metadata,
             file_type, source_hash_algorithm, source_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      doc.id,
      doc.title,
      doc.path,
      doc.addedAt.toISOString(),
      doc.pageCount,
      doc.sizeBytes,
      JSON.stringify(doc.tags),
      JSON.stringify(doc.metadata ?? {}),
      doc.fileType,
      sourceIdentity.algorithm,
      sourceIdentity.hash,
    ],
  };
}

function refreshDocumentStatement(
  doc: Document,
  sourceIdentity: SourceIdentity,
): InStatement {
  const chunker = JSON.stringify(doc.metadata?.chunker ?? null);
  const visuals = JSON.stringify(doc.metadata?.visuals ?? null);
  return {
    sql: `UPDATE documents
          SET page_count = ?,
              size_bytes = ?,
              file_type = ?,
              metadata = json_set(
                COALESCE(metadata, '{}'),
                '$.chunker', json(?),
                '$.visuals', json(?)
              ),
              source_hash_algorithm = ?,
              source_hash = ?
          WHERE id = ?`,
    args: [
      doc.pageCount,
      doc.sizeBytes,
      doc.fileType,
      chunker,
      visuals,
      sourceIdentity.algorithm,
      sourceIdentity.hash,
      doc.id,
    ],
  };
}

function chunkInsertStatement(chunk: ChunkInput): InStatement {
  return {
    sql: `INSERT INTO chunks
            (id, doc_id, page, chunk_index, content, embedding_content)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      chunk.id,
      chunk.docId,
      chunk.page,
      chunk.chunkIndex,
      chunk.content,
      chunk.embeddingContent ?? chunk.content,
    ],
  };
}

function embeddingUpsertStatement(item: EmbeddingInput): InStatement {
  return {
    sql: `INSERT INTO embeddings (chunk_id, embedding)
          VALUES (?, vector32(?))
          ON CONFLICT (chunk_id) DO UPDATE SET
            embedding = excluded.embedding`,
    args: [item.chunkId, JSON.stringify(item.embedding)],
  };
}

function documentListQuery(tag?: string): { sql: string; args: InValue[] } {
  const args: InValue[] = [];
  let sql = DOCUMENT_SELECT_SQL;
  if (tag) {
    sql += ` WHERE ${DOCUMENT_TAG_FILTER_SQL}`;
    args.push(tag);
  }

  return { sql: `${sql} ORDER BY added_at DESC`, args };
}

async function getFirstDecodedRow<A>(
  client: LibSQLClientService["client"],
  statement: InStatement,
  operation: string,
  decodeRow: (row: unknown, operation: string) => A,
): Promise<A | null> {
  const result = await client.execute(statement);
  const row = result.rows[0];
  if (!row) return null;
  return decodeRow(row, operation);
}

async function listDecodedRows<A>(
  client: LibSQLClientService["client"],
  statement: InStatement,
  operation: string,
  decodeRow: (row: unknown, operation: string) => A,
): Promise<A[]> {
  const result = await client.execute(statement);
  return result.rows.map((row) => decodeRow(row, operation));
}

function validateSourceIdentity(sourceIdentity: SourceIdentity): void {
  if (
    sourceIdentity.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/.test(sourceIdentity.hash)
  ) {
    throw new Error("Invalid source identity");
  }
}

function makeDocumentRepository(
  db: LibSQLClientService,
): DocumentRepositoryService & DocumentIntegrityRepositoryService {
  const { client, vectors } = db;

  return {
    getDocument: (id) =>
      storageEffect("get document", () =>
        getFirstDecodedRow(
          client,
          {
            sql: "SELECT * FROM documents WHERE id = ?",
            args: [id],
          },
          "get document",
          decodeDocumentRow,
        ),
      ),

    getDocumentByPath: (path) =>
      storageEffect("get document by path", () =>
        getFirstDecodedRow(
          client,
          {
            sql: "SELECT * FROM documents WHERE path = ?",
            args: [path],
          },
          "get document by path",
          decodeDocumentRow,
        ),
      ),

    listDocuments: (tag) =>
      storageEffect("list documents", () =>
        listDecodedRows(
          client,
          documentListQuery(tag),
          "list documents",
          decodeDocumentRow,
        ),
      ),

    deleteDocument: (id) =>
      storageEffect("delete document", async () => {
        await client.execute({
          sql: "DELETE FROM documents WHERE id = ?",
          args: [id],
        });
      }),

    updateTags: (id, tags) =>
      storageEffect("update document tags", async () => {
        await client.execute({
          sql: "UPDATE documents SET tags = ? WHERE id = ?",
          args: [JSON.stringify(tags), id],
        });
      }),

    updateDocumentPath: (id, path) =>
      storageEffect("update document path", async () => {
        await client.execute({
          sql: "UPDATE documents SET path = ? WHERE id = ?",
          args: [path, id],
        });
      }),

    getChunk: (chunkId) =>
      storageEffect("get chunk", () =>
        getFirstDecodedRow(
          client,
          {
            sql: `SELECT id, doc_id, page, chunk_index, content, embedding_content
                FROM chunks WHERE id = ?`,
            args: [chunkId],
          },
          "get chunk",
          decodeChunkRow,
        ),
      ),

    listChunksByDocument: (docId, options) =>
      storageEffect("list document chunks", async () => {
        const args: InValue[] = [docId];
        let sql = `SELECT id, doc_id, page, chunk_index, content, embedding_content
                   FROM chunks WHERE doc_id = ?`;
        if (typeof options?.page === "number") {
          sql += " AND page = ?";
          args.push(options.page);
        }
        sql += " ORDER BY page ASC, chunk_index ASC";
        return listDecodedRows(
          client,
          { sql, args },
          "list document chunks",
          decodeChunkRow,
        );
      }),

    addEmbeddings: (embeddings) =>
      storageEffect("add embeddings", async () => {
        if (embeddings.length === 0) return;
        await vectors.ensureForEmbeddings(embeddings);
        await client.batch(
          embeddings.map(embeddingUpsertStatement),
          "write",
        );
      }),

    replaceDocument: (doc, chunks, embeddings, sourceIdentity, mode) =>
      storageEffect("replace document", async () => {
        validateSourceIdentity(sourceIdentity);
        await vectors.ensureForEmbeddings(embeddings);
        const statements: InStatement[] = [
          mode === "add"
            ? documentInsertStatement(doc, sourceIdentity)
            : refreshDocumentStatement(doc, sourceIdentity),
          {
            sql: "DELETE FROM chunks WHERE doc_id = ?",
            args: [doc.id],
          },
          ...chunks.map(chunkInsertStatement),
          ...embeddings.map(embeddingUpsertStatement),
        ];
        await client.batch(statements, "write");
      }),

    getDocumentWithSourceIdentity: (id) =>
      storageEffect("get document source identity", () =>
        getFirstDecodedRow(
          client,
          {
            sql: "SELECT * FROM documents WHERE id = ?",
            args: [id],
          },
          "get document source identity",
          decodeDocumentWithSourceIdentityRow,
        ),
      ),

    listDocumentsWithSourceIdentity: (tag) =>
      storageEffect("list document source identities", () =>
        listDecodedRows(
          client,
          documentListQuery(tag),
          "list document source identities",
          decodeDocumentWithSourceIdentityRow,
        ),
      ),
  };
}

function makeSearchRepository(
  db: LibSQLClientService,
): SearchRepositoryService {
  const { client, vectors } = db;

  return {
    vectorSearch: (queryEmbedding, options) =>
      storageEffect("vector search", async () => {
        if (!(await vectors.ensureForQuery(queryEmbedding.length))) return [];

        const { limit = 10, tags } = options ?? {};
        const queryVector = JSON.stringify(queryEmbedding);
        const filterByTags = tags !== undefined && tags.length > 0;

        // vector_top_k ranks the whole library before any WHERE clause runs,
        // so a tag filter could discard every candidate. Tag-filtered searches
        // scan the tagged chunks exactly instead of using the ANN index.
        const source = filterByTags
          ? { sql: "embeddings e", args: [] }
          : {
              sql: `vector_top_k('embeddings_idx', vector32(?), ?) AS top
                    JOIN embeddings e ON e.rowid = top.id`,
              args: [queryVector, limit],
            };
        const args: InValue[] = [queryVector, ...source.args];
        let tagFilter = "";
        if (filterByTags) {
          tagFilter = `WHERE ${tags
            .map(
              () => "EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)",
            )
            .join(" OR ")}`;
          args.push(...tags);
        }

        const result = await client.execute({
          sql: `SELECT
                  c.id AS chunk_id,
                  c.doc_id,
                  d.title,
                  c.page,
                  c.chunk_index,
                  c.content,
                  vector_distance_cos(e.embedding, vector32(?)) AS distance
                FROM ${source.sql}
                JOIN chunks c ON c.id = e.chunk_id
                JOIN documents d ON d.id = c.doc_id
                ${tagFilter}
                ORDER BY distance ASC
                LIMIT ${limit}`,
          args,
        });
        return result.rows.map((row) =>
          decodeVectorSearchRow(row, "vector search"),
        );
      }),

    ftsSearch: (query, options) =>
      storageEffect("full-text search", async () => {
        const { limit = 10, tags } = options ?? {};
        const escapedQuery = `"${query.replace(/"/g, '""')}"`;
        const args: InValue[] = [escapedQuery];
        let sql = `SELECT
                     c.id AS chunk_id,
                     c.doc_id,
                     d.title,
                     c.page,
                     c.chunk_index,
                     c.content,
                     fts.rank AS rank
                   FROM chunks_fts fts
                   JOIN chunks c ON c.rowid = fts.rowid
                   JOIN documents d ON d.id = c.doc_id
                   WHERE fts.content MATCH ?`;
        if (tags && tags.length > 0) {
          sql += ` AND EXISTS (
            SELECT 1 FROM json_each(d.tags)
            WHERE value IN (${tags.map(() => "?").join(", ")})
          )`;
          args.push(...tags);
        }
        sql += " ORDER BY fts.rank ASC LIMIT ?";
        args.push(limit);
        const result = await client.execute({ sql, args });
        return result.rows.map((row) =>
          decodeFtsSearchRow(row, "full-text search"),
        );
      }),

    getExpandedContext: (docId, page, chunkIndex, maxChars) =>
      storageEffect("expand chunk context", async () => {
        const targetResult = await client.execute({
          sql: `SELECT content
                FROM chunks
                WHERE doc_id = ? AND page = ? AND chunk_index = ?`,
          args: [docId, page, chunkIndex],
        });
        const targetRow = targetResult.rows[0];
        if (!targetRow) return null;

        let content = decodeContextRow(targetRow, "expand chunk context");
        const fits = (extra: string) =>
          content.length + extra.length <= maxChars * CONTEXT_LENGTH_TOLERANCE;

        const beforeResult = await client.execute({
          sql: `SELECT content
                FROM chunks
                WHERE doc_id = ?
                  AND (page, chunk_index) < (?, ?)
                ORDER BY page DESC, chunk_index DESC
                LIMIT ${CONTEXT_QUERY_LIMIT}`,
          args: [docId, page, chunkIndex],
        });
        for (const row of beforeResult.rows) {
          const previous = decodeContextRow(row, "expand chunk context");
          if (!fits(previous)) break;
          content = `${previous}\n${content}`;
        }

        const afterResult = await client.execute({
          sql: `SELECT content
                FROM chunks
                WHERE doc_id = ?
                  AND (page, chunk_index) > (?, ?)
                ORDER BY page ASC, chunk_index ASC
                LIMIT ${CONTEXT_QUERY_LIMIT}`,
          args: [docId, page, chunkIndex],
        });
        for (const row of afterResult.rows) {
          const next = decodeContextRow(row, "expand chunk context");
          if (!fits(next)) break;
          content = `${content}\n${next}`;
        }

        return content;
      }),
  };
}

function makeMaintenanceRepository(
  db: LibSQLClientService,
): LibraryMaintenanceService {
  const { client, mode } = db;

  return {
    getStats: () =>
      storageEffect("get library statistics", async () => {
        const documents = await client.execute(
          "SELECT COUNT(id) AS count FROM documents",
        );
        const chunks = await client.execute(
          "SELECT COUNT(id) AS count FROM chunks",
        );
        const embeddings = (await tableExists(client, "embeddings"))
          ? await client.execute(
              "SELECT COUNT(chunk_id) AS count FROM embeddings",
            )
          : null;
        return {
          documents: decodeCountRow(
            documents.rows[0],
            "get library statistics",
          ),
          chunks: decodeCountRow(chunks.rows[0], "get library statistics"),
          embeddings: embeddings
            ? decodeCountRow(
                embeddings.rows[0],
                "get library statistics",
              )
            : 0,
        };
      }),

    countChunksByDocumentIds: (docIds) =>
      storageEffect("count document chunks", async () => {
        const counts: Record<string, number> = {};
        for (
          let offset = 0;
          offset < docIds.length;
          offset += DOCUMENT_COUNT_BATCH_SIZE
        ) {
          const ids = docIds.slice(
            offset,
            offset + DOCUMENT_COUNT_BATCH_SIZE,
          );
          const result = await client.execute({
            sql: `SELECT doc_id, COUNT(id) AS count
                  FROM chunks
                  WHERE doc_id IN (${ids.map(() => "?").join(", ")})
                  GROUP BY doc_id`,
            args: ids,
          });
          for (const row of result.rows) {
            const decoded = decodeDocumentCountRow(
              row,
              "count document chunks",
            );
            counts[decoded.docId] = decoded.count;
          }
        }
        for (const id of docIds) counts[id] ??= 0;
        return counts;
      }),

    repair: () =>
      storageEffect("repair library", async () => {
        const orphanedChunksResult = await client.execute(`
          SELECT COUNT(id) AS count FROM chunks c
          WHERE NOT EXISTS (
            SELECT 1 FROM documents d WHERE d.id = c.doc_id
          )
        `);
        const hasEmbeddings = await tableExists(client, "embeddings");
        const orphanedEmbeddingsResult = hasEmbeddings
          ? await client.execute(`
              SELECT COUNT(chunk_id) AS count FROM embeddings e
              WHERE NOT EXISTS (
                SELECT 1 FROM chunks c WHERE c.id = e.chunk_id
              )
            `)
          : null;
        const orphanedChunks = decodeCountRow(
          orphanedChunksResult.rows[0],
          "repair library",
        );
        const orphanedEmbeddings = orphanedEmbeddingsResult
          ? decodeCountRow(
              orphanedEmbeddingsResult.rows[0],
              "repair library",
            )
          : 0;

        const statements: InStatement[] = [];
        if (orphanedEmbeddings > 0) {
          statements.push(`
            DELETE FROM embeddings
            WHERE NOT EXISTS (
              SELECT 1 FROM chunks WHERE chunks.id = embeddings.chunk_id
            )
          `);
        }
        if (orphanedChunks > 0) {
          statements.push(`
            DELETE FROM chunks
            WHERE NOT EXISTS (
              SELECT 1 FROM documents WHERE documents.id = chunks.doc_id
            )
          `);
        }
        if (statements.length > 0) {
          await client.batch(statements, "write");
        }
        return { orphanedChunks, orphanedEmbeddings };
      }),

    checkpoint: () =>
      storageEffect("checkpoint library", async () => {
        if (mode === "local") {
          await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
        }
      }),
  };
}

export function makeLibSQLRepositories() {
  return Layer.mergeAll(
    Layer.effect(
      DocumentRepository,
      Effect.map(LibSQLClient, makeDocumentRepository),
    ),
    Layer.effect(
      DocumentIntegrityRepository,
      Effect.map(LibSQLClient, makeDocumentRepository),
    ),
    Layer.effect(
      SearchRepository,
      Effect.map(LibSQLClient, makeSearchRepository),
    ),
    Layer.effect(
      LibraryMaintenance,
      Effect.map(LibSQLClient, makeMaintenanceRepository),
    ),
    Layer.effect(
      VectorRebuildRepository,
      Effect.map(LibSQLClient, makeVectorRebuildRepository),
    ),
  );
}
