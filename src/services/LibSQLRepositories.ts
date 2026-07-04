import type { InStatement, InValue } from "@libsql/client";
import { Effect, Layer } from "effect";
import type { Config, Document } from "../types.js";
import {
  DocumentIntegrityRepository,
  DocumentRepository,
  LibraryMaintenance,
  SearchRepository,
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
import type { SourceIdentity } from "./SourceIntegrity.js";

type RepositoryConfig = {
  embeddingProvider: string;
  embeddingModel: string;
};

const CONTEXT_QUERY_LIMIT = 20;
const CONTEXT_LENGTH_TOLERANCE = 1.2;
const DOCUMENT_COUNT_BATCH_SIZE = 500;

function documentBaseArgs(doc: Document): InValue[] {
  return [
    doc.id,
    doc.title,
    doc.path,
    doc.addedAt.toISOString(),
    doc.pageCount,
    doc.sizeBytes,
    JSON.stringify(doc.tags),
    JSON.stringify(doc.metadata ?? {}),
    doc.fileType,
  ];
}

function documentArgs(doc: Document, sourceIdentity: SourceIdentity): InValue[] {
  return [
    ...documentBaseArgs(doc),
    sourceIdentity.algorithm,
    sourceIdentity.hash,
  ];
}

function documentInsertStatement(
  doc: Document,
  sourceIdentity: SourceIdentity,
): InStatement {
  return {
    sql: `INSERT INTO documents
            (id, title, path, added_at, page_count, size_bytes, tags, metadata,
             file_type, source_hash_algorithm, source_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: documentArgs(doc, sourceIdentity),
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
  config: RepositoryConfig,
): DocumentRepositoryService & DocumentIntegrityRepositoryService {
  const { client, vectors } = db;
  const embeddingIdentity = {
    provider: config.embeddingProvider,
    model: config.embeddingModel,
  };

  return {
    addDocument: (doc) =>
      storageEffect("add document", async () => {
        await client.execute({
          sql: `INSERT INTO documents
                  (id, title, path, added_at, page_count, size_bytes, tags, metadata, file_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: documentBaseArgs(doc),
        });
      }),

    getDocument: (id) =>
      storageEffect("get document", async () => {
        const result = await client.execute({
          sql: "SELECT * FROM documents WHERE id = ?",
          args: [id],
        });
        const row = result.rows[0];
        return row ? decodeDocumentRow(row, "get document") : null;
      }),

    getDocumentByPath: (path) =>
      storageEffect("get document by path", async () => {
        const result = await client.execute({
          sql: "SELECT * FROM documents WHERE path = ?",
          args: [path],
        });
        const row = result.rows[0];
        return row ? decodeDocumentRow(row, "get document by path") : null;
      }),

    listDocuments: (tag) =>
      storageEffect("list documents", async () => {
        let sql = "SELECT * FROM documents";
        const args: InValue[] = [];
        if (tag) {
          sql +=
            " WHERE json_array_length(tags) > 0 AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)";
          args.push(tag);
        }
        sql += " ORDER BY added_at DESC";
        const result = await client.execute({ sql, args });
        return result.rows.map((row) =>
          decodeDocumentRow(row, "list documents"),
        );
      }),

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

    addChunks: (chunks) =>
      storageEffect("add chunks", async () => {
        if (chunks.length === 0) return;
        await client.batch(chunks.map(chunkInsertStatement), "write");
      }),

    getChunk: (chunkId) =>
      storageEffect("get chunk", async () => {
        const result = await client.execute({
          sql: `SELECT id, doc_id, page, chunk_index, content, embedding_content
                FROM chunks WHERE id = ?`,
          args: [chunkId],
        });
        const row = result.rows[0];
        return row ? decodeChunkRow(row, "get chunk") : null;
      }),

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
        const result = await client.execute({ sql, args });
        return result.rows.map((row) =>
          decodeChunkRow(row, "list document chunks"),
        );
      }),

    addEmbeddings: (embeddings) =>
      storageEffect("add embeddings", async () => {
        if (embeddings.length === 0) return;
        await vectors.ensureForEmbeddings(embeddings, embeddingIdentity);
        await client.batch(
          embeddings.map(embeddingUpsertStatement),
          "write",
        );
      }),

    replaceDocument: (doc, chunks, embeddings, sourceIdentity, mode) =>
      storageEffect("replace document", async () => {
        validateSourceIdentity(sourceIdentity);
        await vectors.ensureForEmbeddings(embeddings, embeddingIdentity);
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
      storageEffect("get document source identity", async () => {
        const result = await client.execute({
          sql: "SELECT * FROM documents WHERE id = ?",
          args: [id],
        });
        const row = result.rows[0];
        return row
          ? decodeDocumentWithSourceIdentityRow(
              row,
              "get document source identity",
            )
          : null;
      }),

    listDocumentsWithSourceIdentity: (tag) =>
      storageEffect("list document source identities", async () => {
        let sql = "SELECT * FROM documents";
        const args: InValue[] = [];
        if (tag) {
          sql +=
            " WHERE json_array_length(tags) > 0 AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)";
          args.push(tag);
        }
        sql += " ORDER BY added_at DESC";
        const result = await client.execute({ sql, args });
        return result.rows.map((row) =>
          decodeDocumentWithSourceIdentityRow(
            row,
            "list document source identities",
          ),
        );
      }),
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

        const {
          limit = 10,
          tags,
          threshold = 0,
          includeClusterSummaries = false,
        } = options ?? {};
        const queryVector = JSON.stringify(queryEmbedding);
        const fetchLimit = tags && tags.length > 0 ? limit * 3 : limit;
        const maxDistance = threshold > 0 ? 2 * (1 - threshold) : null;

        const chunkArgs: InValue[] = [
          queryVector,
          queryVector,
          fetchLimit,
        ];
        const chunkConditions: string[] = [];
        if (tags && tags.length > 0) {
          chunkConditions.push(
            `(${tags
              .map(
                () =>
                  "EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?)",
              )
              .join(" OR ")})`,
          );
          chunkArgs.push(...tags);
        }
        if (maxDistance !== null) {
          chunkConditions.push(
            "vector_distance_cos(e.embedding, vector32(?)) <= ?",
          );
          chunkArgs.push(queryVector, maxDistance);
        }

        const chunkResult = await client.execute({
          sql: `SELECT
                  c.id AS chunk_id,
                  c.doc_id,
                  d.title,
                  c.page,
                  c.chunk_index,
                  c.content,
                  vector_distance_cos(e.embedding, vector32(?)) AS distance
                FROM vector_top_k('embeddings_idx', vector32(?), ?) AS top
                JOIN embeddings e ON e.rowid = top.id
                JOIN chunks c ON c.id = e.chunk_id
                JOIN documents d ON d.id = c.doc_id
                ${
                  chunkConditions.length > 0
                    ? `WHERE ${chunkConditions.join(" AND ")}`
                    : ""
                }
                ORDER BY distance ASC
                LIMIT ${limit}`,
          args: chunkArgs,
        });

        const rows = [...chunkResult.rows];
        if (includeClusterSummaries) {
          const clusterArgs: InValue[] = [
            queryVector,
            queryVector,
            limit,
          ];
          const clusterConditions: string[] = [];
          if (maxDistance !== null) {
            clusterConditions.push(
              "vector_distance_cos(cs.embedding, vector32(?)) <= ?",
            );
            clusterArgs.push(queryVector, maxDistance);
          }
          const clusterResult = await client.execute({
            sql: `SELECT
                    ('cluster-summary-' || cs.id) AS chunk_id,
                    '' AS doc_id,
                    'Cluster Summary' AS title,
                    0 AS page,
                    cs.id AS chunk_index,
                    cs.summary AS content,
                    vector_distance_cos(cs.embedding, vector32(?)) AS distance
                  FROM vector_top_k('cluster_summaries_idx', vector32(?), ?) AS top
                  JOIN cluster_summaries cs ON cs.rowid = top.id
                  ${
                    clusterConditions.length > 0
                      ? `WHERE ${clusterConditions.join(" AND ")}`
                      : ""
                  }`,
            args: clusterArgs,
          });
          rows.push(...clusterResult.rows);
        }

        return rows
          .map((row) => decodeVectorSearchRow(row, "vector search"))
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
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

    getExpandedContext: (docId, page, chunkIndex, options) =>
      storageEffect("expand chunk context", async () => {
        const { maxChars = 2000, direction = "both" } = options ?? {};
        const targetResult = await client.execute({
          sql: `SELECT page, chunk_index, content
                FROM chunks
                WHERE doc_id = ? AND page = ? AND chunk_index = ?`,
          args: [docId, page, chunkIndex],
        });
        const targetRow = targetResult.rows[0];
        if (!targetRow) {
          return {
            content: "",
            startChunk: `p${page}c${chunkIndex}`,
            endChunk: `p${page}c${chunkIndex}`,
          };
        }

        const target = decodeContextRow(targetRow, "expand chunk context");
        let content = target.content;
        let startPage = target.page;
        let startChunkIndex = target.chunkIndex;
        let endPage = target.page;
        let endChunkIndex = target.chunkIndex;

        if (direction === "before" || direction === "both") {
          const beforeResult = await client.execute({
            sql: `SELECT page, chunk_index, content
                  FROM chunks
                  WHERE doc_id = ?
                    AND (page < ? OR (page = ? AND chunk_index < ?))
                  ORDER BY page DESC, chunk_index DESC
                  LIMIT ${CONTEXT_QUERY_LIMIT}`,
            args: [docId, page, page, chunkIndex],
          });
          for (const row of beforeResult.rows) {
            const previous = decodeContextRow(row, "expand chunk context");
            if (
              content.length + previous.content.length >
              maxChars * CONTEXT_LENGTH_TOLERANCE
            ) {
              break;
            }
            content = `${previous.content}\n${content}`;
            startPage = previous.page;
            startChunkIndex = previous.chunkIndex;
          }
        }

        if (direction === "after" || direction === "both") {
          const afterResult = await client.execute({
            sql: `SELECT page, chunk_index, content
                  FROM chunks
                  WHERE doc_id = ?
                    AND (page > ? OR (page = ? AND chunk_index > ?))
                  ORDER BY page ASC, chunk_index ASC
                  LIMIT ${CONTEXT_QUERY_LIMIT}`,
            args: [docId, page, page, chunkIndex],
          });
          for (const row of afterResult.rows) {
            const next = decodeContextRow(row, "expand chunk context");
            if (
              content.length + next.content.length >
              maxChars * CONTEXT_LENGTH_TOLERANCE
            ) {
              break;
            }
            content = `${content}\n${next.content}`;
            endPage = next.page;
            endChunkIndex = next.chunkIndex;
          }
        }

        return {
          content,
          startChunk: `p${startPage}c${startChunkIndex}`,
          endChunk: `p${endPage}c${endChunkIndex}`,
        };
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
        return {
          orphanedChunks,
          orphanedEmbeddings,
          zeroVectorEmbeddings: 0,
        };
      }),

    checkpoint: () =>
      storageEffect("checkpoint library", async () => {
        if (mode === "local") {
          await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
        }
      }),
  };
}

export function makeLibSQLRepositories(config: Config) {
  const repositoryConfig: RepositoryConfig = {
    embeddingProvider: config.models.embedding.provider,
    embeddingModel: config.models.embedding.model,
  };
  return Layer.mergeAll(
    Layer.effect(
      DocumentRepository,
      Effect.map(LibSQLClient, (client) =>
        makeDocumentRepository(client, repositoryConfig),
      ),
    ),
    Layer.effect(
      DocumentIntegrityRepository,
      Effect.map(LibSQLClient, (client) =>
        makeDocumentRepository(client, repositoryConfig),
      ),
    ),
    Layer.effect(
      SearchRepository,
      Effect.map(LibSQLClient, makeSearchRepository),
    ),
    Layer.effect(
      LibraryMaintenance,
      Effect.map(LibSQLClient, makeMaintenanceRepository),
    ),
  );
}
