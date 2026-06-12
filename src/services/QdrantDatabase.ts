/**
 * Qdrant Database Service
 *
 * Implements the Database interface using @qdrant/js-client-rest.
 */

import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Database } from "./Database.js";
import {
  DatabaseError,
  Document,
  DocumentSearchResult,
  PDFChunk,
  type DocumentFileType,
} from "../types.js";
import { inferFileTypeFromPath } from "../chunking.js";

const DOCUMENT_VECTOR_DIM = 1;
const METADATA_VECTOR_DIM = 1;
const SCROLL_PAGE_SIZE = 256;

/**
 * Qdrant point IDs must be UUIDs or integers. Hash arbitrary external IDs into
 * a stable UUID-shaped string and keep the original ID in payload.
 */
function toPointId(id: string): string {
  const hex = createHash("sha256").update(id).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type QdrantPayload = Record<string, unknown>;
type QdrantPoint = {
  id: string | number;
  payload?: QdrantPayload;
  vector?: unknown;
  score?: number;
};
type QdrantUpsertPoint = {
  id: string | number;
  vector: number[];
  payload: QdrantPayload;
};

type ChunkInput = {
  id: string;
  docId: string;
  page: number;
  chunkIndex: number;
  content: string;
  embeddingContent?: string;
};

export class QdrantDatabase {
  static make(config: {
    url: string;
    collection: string;
    apiKey?: string;
    embeddingDimension?: number;
  }) {
    let embeddingDimension = config.embeddingDimension;
    const documentsCollection = `${config.collection}-documents`;
    const chunksCollection = `${config.collection}-chunks`;
    const embeddingsCollection = `${config.collection}-embeddings`;

    const client = new QdrantClient({
      url: config.url,
      apiKey: config.apiKey,
      checkCompatibility: false,
    });

    let metadataInitialized = false;
    let metadataInitializing: Promise<void> | null = null;
    let embeddingsInitialized = false;
    let embeddingsInitializing: Promise<void> | null = null;

    const resolveEmbeddingDimension = (dimension?: number): number | undefined => {
      const resolved = dimension ?? embeddingDimension;
      if (dimension !== undefined && (!Number.isFinite(dimension) || dimension <= 0)) {
        throw new Error(`Invalid embedding dimension: ${dimension}`);
      }
      if (
        embeddingDimension !== undefined &&
        dimension !== undefined &&
        embeddingDimension !== dimension
      ) {
        throw new Error(
          `Embedding dimension ${dimension} does not match existing Qdrant collection dimension ${embeddingDimension}`,
        );
      }
      if (resolved !== undefined) embeddingDimension = resolved;
      return resolved;
    };

    const requireEmbeddingDimension = (dimension?: number): number => {
      const resolved = resolveEmbeddingDimension(dimension);
      if (resolved === undefined) {
        throw new Error("Embedding dimension is not established yet");
      }
      return resolved;
    };

    const ensureMetadataCollections = async (): Promise<void> => {
      if (metadataInitialized) return;
      if (metadataInitializing) return metadataInitializing;

      metadataInitializing = (async () => {
        const docsExists = await client.collectionExists(documentsCollection);
        if (!docsExists.exists) {
          await client.createCollection(documentsCollection, {
            vectors: {
              size: DOCUMENT_VECTOR_DIM,
              distance: "Cosine",
            },
          });

          // Fast metadata filtering for document lookups/tag queries.
          await safeCreatePayloadIndex(client, documentsCollection, "path", "keyword");
          await safeCreatePayloadIndex(client, documentsCollection, "tags", "keyword");
          await safeCreatePayloadIndex(client, documentsCollection, "addedAt", "datetime");
        }

        const chunksExists = await client.collectionExists(chunksCollection);
        if (!chunksExists.exists) {
          await client.createCollection(chunksCollection, {
            vectors: {
              size: METADATA_VECTOR_DIM,
              distance: "Cosine",
            },
          });

          // Payload indexes for structured filters + full text on chunk content.
          await safeCreatePayloadIndex(client, chunksCollection, "docId", "keyword");
          await safeCreatePayloadIndex(client, chunksCollection, "page", "integer");
          await safeCreatePayloadIndex(
            client,
            chunksCollection,
            "chunkIndex",
            "integer",
          );
          await safeCreatePayloadIndex(client, chunksCollection, "tags", "keyword");
          await safeCreatePayloadIndex(client, chunksCollection, "content", "text");
        }

        metadataInitialized = true;
      })();

      try {
        await metadataInitializing;
      } finally {
        metadataInitializing = null;
      }
    };

    const ensureEmbeddingCollection = async (dimension: number): Promise<void> => {
      await ensureMetadataCollections();
      const vectorDimension = requireEmbeddingDimension(dimension);
      if (embeddingsInitialized) return;
      if (embeddingsInitializing) return embeddingsInitializing;

      embeddingsInitializing = (async () => {
        const embeddingsExists = await client.collectionExists(embeddingsCollection);
        if (!embeddingsExists.exists) {
          await client.createCollection(embeddingsCollection, {
            vectors: {
              size: vectorDimension,
              distance: "Cosine",
            },
          });

          await safeCreatePayloadIndex(client, embeddingsCollection, "docId", "keyword");
          await safeCreatePayloadIndex(client, embeddingsCollection, "tags", "keyword");
        }

        embeddingsInitialized = true;
      })();

      try {
        await embeddingsInitializing;
      } finally {
        embeddingsInitializing = null;
      }
    };

    const embeddingCollectionExists = async (): Promise<boolean> => {
      if (embeddingsInitialized) return true;
      const exists = await client.collectionExists(embeddingsCollection);
      embeddingsInitialized = exists.exists;
      return exists.exists;
    };

    const withDb = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: async () => {
          await ensureMetadataCollections();
          return run();
        },
        catch: (error) => {
          const msg = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? error.stack : undefined;
          console.error(`[QdrantDatabase] Error:`, msg, stack ? `\n${stack}` : "");
          return new DatabaseError({ reason: msg });
        },
      });

    const readDocumentsByIds = async (docIds: string[]): Promise<Map<string, QdrantPayload>> => {
      if (docIds.length === 0) return new Map();
      const records = await client.retrieve(documentsCollection, {
        ids: docIds.map(toPointId),
        with_payload: true,
        with_vector: false,
      });

      const map = new Map<string, QdrantPayload>();
      for (const record of records as unknown as QdrantPoint[]) {
        if (record.payload) {
          map.set(resolvePayloadId(record.id, record.payload), record.payload);
        }
      }
      return map;
    };

    return Layer.succeed(Database, {
      addDocument: (doc) =>
        withDb(async () => {
          await client.upsert(documentsCollection, {
            wait: true,
            points: [
              {
                id: toPointId(doc.id),
                vector: [0],
                payload: serializeDocument(doc),
              },
            ],
          });
        }),

      getDocument: (id) =>
        withDb(async () => {
          const records = await client.retrieve(documentsCollection, {
            ids: [toPointId(id)],
            with_payload: true,
            with_vector: false,
          });

          const first = (records[0] as unknown as QdrantPoint | undefined) ?? null;
          if (!first?.payload) return null;
          return payloadToDocument(first.id, first.payload);
        }),

      getDocumentByPath: (path) =>
        withDb(async () => {
          const records = await scrollAll(client, documentsCollection, {
            filter: {
              must: [
                {
                  key: "path",
                  match: { value: path },
                },
              ],
            },
            with_payload: true,
            with_vector: false,
          });

          const first = records[0];
          if (!first?.payload) return null;
          return payloadToDocument(first.id, first.payload);
        }),

      listDocuments: (tag) =>
        withDb(async () => {
          const filter =
            tag && tag.length > 0
              ? {
                  must: [
                    {
                      key: "tags",
                      match: { any: [tag] },
                    },
                  ],
                }
              : undefined;

          const records = await scrollAll(client, documentsCollection, {
            filter,
            with_payload: true,
            with_vector: false,
          });

          return records
            .filter((record) => Boolean(record.payload))
            .map((record) => payloadToDocument(record.id, record.payload!))
            .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
        }),

      deleteDocument: (id) =>
        withDb(async () => {
          await client.delete(documentsCollection, {
            wait: true,
            points: [toPointId(id)],
          });

          await client.delete(chunksCollection, {
            wait: true,
            filter: docIdFilter(id),
          });

          if (await embeddingCollectionExists()) {
            await client.delete(embeddingsCollection, {
              wait: true,
              filter: docIdFilter(id),
            });
          }
        }),

      updateTags: (id, tags) =>
        withDb(async () => {
          await client.setPayload(documentsCollection, {
            points: [toPointId(id)],
            payload: { tags },
          });

          await client.setPayload(chunksCollection, {
            filter: docIdFilter(id),
            payload: { tags },
          });

          if (await embeddingCollectionExists()) {
            await client.setPayload(embeddingsCollection, {
              filter: docIdFilter(id),
              payload: { tags },
            });
          }
        }),

      addChunks: (chunks) =>
        withDb(async () => {
          if (chunks.length === 0) return;

          const docIds = [...new Set(chunks.map((chunk) => chunk.docId))];
          const docsById = await readDocumentsByIds(docIds);

          const points = chunks.map((chunk) => {
            const docPayload = docsById.get(chunk.docId);
            return metadataPoint(serializeChunk(chunk, docPayload, false));
          });

          await client.upsert(chunksCollection, {
            wait: true,
            points,
          });

          if (await embeddingCollectionExists()) {
            const existing = await client.retrieve(embeddingsCollection, {
              ids: chunks.map((chunk) => toPointId(chunk.id)),
              with_payload: true,
              with_vector: false,
            });
            const existingIds = new Set(
              (existing as unknown as QdrantPoint[]).map((point) => point.id),
            );
            const payloadUpdates = points.filter((point) =>
              existingIds.has(point.id),
            );

            for (const point of payloadUpdates) {
              await client.setPayload(embeddingsCollection, {
                points: [point.id],
                payload: {
                  ...point.payload,
                  hasEmbedding: true,
                  embeddingOnly: false,
                },
              });
            }

            if (payloadUpdates.length > 0) {
              await client.setPayload(chunksCollection, {
                points: payloadUpdates.map((point) => point.id),
                payload: { hasEmbedding: true },
              });
            }
          }
        }),

      getChunk: (chunkId) =>
        withDb(async () => {
          const records = await client.retrieve(chunksCollection, {
            ids: [toPointId(chunkId)],
            with_payload: true,
            with_vector: false,
          });

          const point = (records[0] as unknown as QdrantPoint | undefined) ?? null;
          if (!point?.payload) return null;
          return payloadToChunk(point.id, point.payload);
        }),

      listChunksByDocument: (docId, opts) =>
        withDb(async () => {
          const must: Array<Record<string, unknown>> = [
            {
              key: "docId",
              match: { value: docId },
            },
          ];

          if (typeof opts?.page === "number") {
            must.push({
              key: "page",
              match: { value: opts.page },
            });
          }

          const records = await scrollAll(client, chunksCollection, {
            filter: { must },
            with_payload: true,
            with_vector: false,
          });

          return records
            .filter((record) => Boolean(record.payload))
            .map((record) => payloadToChunk(record.id, record.payload!))
            .sort(compareChunks);
        }),

      addEmbeddings: (embeddings) =>
        withDb(async () => {
          if (embeddings.length === 0) return;
          await ensureEmbeddingCollection(embeddings[0]!.embedding.length);

          const ids = embeddings.map((item) => toPointId(item.chunkId));
          const existing = await client.retrieve(chunksCollection, {
            ids,
            with_payload: true,
            with_vector: false,
          });

          const existingById = new Map<string, QdrantPayload>();
          for (const record of existing as unknown as QdrantPoint[]) {
            if (record.payload) {
              existingById.set(String(record.id), record.payload);
            }
          }

          const points = embeddings.map((item) => {
            const existingPayload = existingById.get(toPointId(item.chunkId));

            if (!existingPayload) {
              return {
                id: toPointId(item.chunkId),
                vector: item.embedding,
                payload: embeddingOnlyPayload(item.chunkId),
              };
            }

            return {
              id: toPointId(item.chunkId),
              vector: item.embedding,
              payload: {
                ...existingPayload,
                hasEmbedding: true,
                embeddingOnly: asBoolean(existingPayload.embeddingOnly),
              },
            };
          });

          const chunkPoints = points
            .filter((point) => !asBoolean(point.payload.embeddingOnly))
            .map((point) =>
              metadataPoint({
                ...point.payload,
                hasEmbedding: true,
              }),
            );

          if (chunkPoints.length > 0) {
            await client.upsert(chunksCollection, {
              wait: true,
              points: chunkPoints,
            });
          }

          await client.upsert(embeddingsCollection, {
            wait: true,
            points,
          });
        }),

      replaceDocument: (doc, chunks, embeddings) =>
        withDb(async () => {
          if (embeddings.length > 0) {
            await ensureEmbeddingCollection(embeddings[0]!.embedding.length);
          }

          await client.upsert(documentsCollection, {
            wait: true,
            points: [
              {
                id: toPointId(doc.id),
                vector: [0],
                payload: serializeDocument(doc),
              },
            ],
          });

          await client.delete(chunksCollection, {
            wait: true,
            filter: docIdFilter(doc.id),
          });

          if (await embeddingCollectionExists()) {
            await client.delete(embeddingsCollection, {
              wait: true,
              filter: docIdFilter(doc.id),
            });
          }

          const embeddingMap = new Map<string, number[]>(
            embeddings.map((item) => [item.chunkId, item.embedding]),
          );

          if (chunks.length > 0) {
            await client.upsert(chunksCollection, {
              wait: true,
              points: chunks.map((chunk) =>
                metadataPoint(
                  serializeChunk(chunk, doc, embeddingMap.has(chunk.id)),
                ),
              ),
            });
          }

          if (embeddings.length > 0) {
            await client.upsert(embeddingsCollection, {
              wait: true,
              points: chunks
                .filter((chunk) => embeddingMap.has(chunk.id))
                .map((chunk) => ({
                  id: toPointId(chunk.id),
                  vector: embeddingMap.get(chunk.id)!,
                  payload: serializeChunk(chunk, doc, true),
                })),
            });
          }
        }),

      vectorSearch: (embedding, options) =>
        withDb(async () => {
          if (!(await embeddingCollectionExists())) return [];
          resolveEmbeddingDimension(embedding.length);

          const { limit = 10, tags, threshold = 0.0 } = options || {};

          const must: Array<Record<string, unknown>> = [
            {
              key: "hasEmbedding",
              match: { value: true },
            },
          ];

          if (tags && tags.length > 0) {
            must.push({
              key: "tags",
              match: { any: tags },
            });
          }

          const points = await client.search(embeddingsCollection, {
            vector: embedding,
            limit,
            with_payload: true,
            with_vector: false,
            filter: { must },
            score_threshold: threshold > 0 ? threshold : undefined,
          });

          return (points as unknown as QdrantPoint[])
            .filter((point) => Boolean(point.payload))
            .map((point) => pointToVectorResult(point));
        }),

      ftsSearch: (query, options) =>
        withDb(async () => {
          const { limit = 10, tags } = options || {};

          const must: Array<Record<string, unknown>> = [
            {
              key: "content",
              match: { text: query },
            },
          ];

          if (tags && tags.length > 0) {
            must.push({
              key: "tags",
              match: { any: tags },
            });
          }

          const points = await scrollAll(client, chunksCollection, {
            filter: { must },
            with_payload: true,
            with_vector: false,
          });

          return points
            .filter((point) => Boolean(point.payload))
            .map((point) => {
              const payload = point.payload!;
              const content = asString(payload.content);
              const raw = fullTextRank(content, query);
              const score = raw / (1 + raw);

              return new DocumentSearchResult({
                chunkId: resolvePayloadId(point.id, payload),
                docId: asString(payload.docId),
                title: asString(payload.title),
                page: asNumber(payload.page),
                chunkIndex: asNumber(payload.chunkIndex),
                content,
                score,
                rawScore: raw,
                scoreType: "fts_rank",
                ftsRank: raw,
                matchType: "fts",
                entityType: "document",
              });
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
        }),

      getExpandedContext: (docId, page, chunkIndex, options) =>
        withDb(async () => {
          const { maxChars = 2000, direction = "both" } = options || {};

          const points = await scrollAll(client, chunksCollection, {
            filter: docIdFilter(docId),
            with_payload: true,
            with_vector: false,
          });

          const chunks = points
            .filter((point) => Boolean(point.payload))
            .map((point) => payloadToChunk(point.id, point.payload!))
            .sort(compareChunks);

          const targetIndex = chunks.findIndex(
            (chunk) => chunk.page === page && chunk.chunkIndex === chunkIndex,
          );

          if (targetIndex < 0) {
            return {
              content: "",
              startChunk: `p${page}c${chunkIndex}`,
              endChunk: `p${page}c${chunkIndex}`,
            };
          }

          let start = targetIndex;
          let end = targetIndex;
          let total = chunks[targetIndex]!.content;

          if (direction === "before" || direction === "both") {
            for (let i = targetIndex - 1; i >= 0; i--) {
              const next = chunks[i]!.content;
              if (total.length + next.length > maxChars * 1.2) break;
              total = `${next}\n${total}`;
              start = i;
            }
          }

          if (direction === "after" || direction === "both") {
            for (let i = targetIndex + 1; i < chunks.length; i++) {
              const next = chunks[i]!.content;
              if (total.length + next.length > maxChars * 1.2) break;
              total = `${total}\n${next}`;
              end = i;
            }
          }

          return {
            content: total,
            startChunk: `p${chunks[start]!.page}c${chunks[start]!.chunkIndex}`,
            endChunk: `p${chunks[end]!.page}c${chunks[end]!.chunkIndex}`,
          };
        }),

      getStats: () =>
        withDb(async () => {
          const [documents, chunks] = await Promise.all([
            client.count(documentsCollection, { exact: true }),
            client.count(chunksCollection, { exact: true }),
          ]);
          const embeddings = (await embeddingCollectionExists())
            ? await client.count(embeddingsCollection, { exact: true })
            : { count: 0 };

          return {
            documents: documents.count,
            chunks: chunks.count,
            embeddings: embeddings.count,
          };
        }),

      countChunksByDocumentIds: (docIds) =>
        withDb(async () => {
          const counts: Record<string, number> = {};
          if (docIds.length === 0) return counts;

          for (const docId of docIds) {
            const result = await client.count(chunksCollection, {
              exact: true,
              filter: docIdFilter(docId),
            });
            counts[docId] = result.count;
          }

          return counts;
        }),

      repair: () =>
        withDb(async () => {
          const docs = await scrollAll(client, documentsCollection, {
            with_payload: true,
            with_vector: false,
          });
          const docIds = new Set(
            docs
              .filter((doc) => Boolean(doc.payload))
              .map((doc) => resolvePayloadId(doc.id, doc.payload!)),
          );

          const chunks = await scrollAll(client, chunksCollection, {
            with_payload: true,
            with_vector: false,
          });
          const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
          const chunkIds = new Set(chunksById.keys());

          const orphanedEmbeddingIds: Array<string | number> = [];
          const staleEmbeddingOnlyIds: Array<string | number> = [];
          const orphanedChunkIds: Array<string | number> = [];
          let zeroVectorEmbeddings = 0;
          const hasEmbeddingCollection = await embeddingCollectionExists();

          for (const point of chunks) {
            const payload = point.payload ?? {};
            const docId = asString(payload.docId);
            if (docId.length > 0 && !docIds.has(docId)) {
              orphanedChunkIds.push(point.id);
            }
          }

          if (hasEmbeddingCollection) {
            const embeddings = await scrollAll(client, embeddingsCollection, {
              with_payload: true,
              with_vector: true,
            });

            for (const point of embeddings) {
              const payload = point.payload ?? {};
              const isEmbeddingOnly = asBoolean(payload.embeddingOnly);

              if (isZeroVector(point.vector)) {
                zeroVectorEmbeddings += 1;
              }

              if (!chunkIds.has(point.id)) {
                orphanedEmbeddingIds.push(point.id);
              } else if (isEmbeddingOnly) {
                staleEmbeddingOnlyIds.push(point.id);
              }
            }
          }

          if (orphanedEmbeddingIds.length > 0 && hasEmbeddingCollection) {
            await client.delete(embeddingsCollection, {
              wait: true,
              points: orphanedEmbeddingIds,
            });
          }

          if (staleEmbeddingOnlyIds.length > 0 && hasEmbeddingCollection) {
            for (const id of staleEmbeddingOnlyIds) {
              const chunk = chunksById.get(id);
              if (!chunk?.payload) continue;
              await client.setPayload(embeddingsCollection, {
                points: [id],
                payload: {
                  ...chunk.payload,
                  hasEmbedding: true,
                  embeddingOnly: false,
                },
              });
              await client.setPayload(chunksCollection, {
                points: [id],
                payload: { hasEmbedding: true, embeddingOnly: false },
              });
            }
          }

          if (orphanedChunkIds.length > 0) {
            await client.delete(chunksCollection, {
              wait: true,
              points: orphanedChunkIds,
            });
            if (hasEmbeddingCollection) {
              await client.delete(embeddingsCollection, {
                wait: true,
                points: orphanedChunkIds,
              });
            }
          }

          return {
            orphanedChunks: orphanedChunkIds.length,
            orphanedEmbeddings: orphanedEmbeddingIds.length,
            zeroVectorEmbeddings,
          };
        }),

      checkpoint: () => withDb(async () => {}),

      dumpDataDir: () => withDb(async () => new Blob([])),

      streamEmbeddings: async function* (batchSize: number) {
        await ensureMetadataCollections();
        if (!(await embeddingCollectionExists())) return;

        let offset: string | number | Record<string, unknown> | null | undefined;

        while (true) {
          const page = await client.scroll(embeddingsCollection, {
            limit: batchSize,
            offset,
            with_payload: true,
            with_vector: true,
          });

          const points = ((page.points ?? []) as unknown as QdrantPoint[])
            .filter((point) => Array.isArray(point.vector))
            .map((point) => ({
              chunkId: resolvePayloadId(point.id, point.payload),
              embedding: point.vector as number[],
            }));

          if (points.length > 0) {
            yield points;
          }

          if (!page.next_page_offset) break;
          offset = page.next_page_offset;
        }
      },

      bulkInsertClusterAssignments: (assignments) =>
        withDb(async () => {
          for (const assignment of assignments) {
            await client.setPayload(chunksCollection, {
              points: [toPointId(assignment.chunkId)],
              payload: {
                clusterId: assignment.clusterId,
                clusterDistance: assignment.distance,
              },
            });
            if (await embeddingCollectionExists()) {
              await client.setPayload(embeddingsCollection, {
                points: [toPointId(assignment.chunkId)],
                payload: {
                  clusterId: assignment.clusterId,
                  clusterDistance: assignment.distance,
                },
              });
            }
          }
        }),
    });
  }
}

async function safeCreatePayloadIndex(
  client: QdrantClient,
  collection: string,
  field: string,
  fieldSchema: "keyword" | "integer" | "text" | "datetime",
): Promise<void> {
  try {
    await client.createPayloadIndex(collection, {
      wait: true,
      field_name: field,
      field_schema: fieldSchema,
    });
  } catch {
    // Index may already exist depending on Qdrant version/configuration.
  }
}

async function scrollAll(
  client: QdrantClient,
  collection: string,
  args: {
    filter?: Record<string, unknown>;
    with_payload?: boolean;
    with_vector?: boolean;
  },
): Promise<QdrantPoint[]> {
  const points: QdrantPoint[] = [];
  let offset: string | number | Record<string, unknown> | null | undefined;

  while (true) {
    const page = await client.scroll(collection, {
      ...args,
      limit: SCROLL_PAGE_SIZE,
      offset,
    });

    const batch = (page.points ?? []) as unknown as QdrantPoint[];
    points.push(...batch);

    if (!page.next_page_offset) {
      break;
    }

    offset = page.next_page_offset;
  }

  return points;
}

function serializeDocument(doc: Document): QdrantPayload {
  return {
    id: doc.id,
    title: doc.title,
    path: doc.path,
    addedAt: doc.addedAt.toISOString(),
    pageCount: doc.pageCount,
    sizeBytes: doc.sizeBytes,
    tags: doc.tags,
    fileType: doc.fileType,
    metadata: doc.metadata ?? {},
  };
}

function docIdFilter(docId: string): { must: Array<Record<string, unknown>> } {
  return {
    must: [
      {
        key: "docId",
        match: { value: docId },
      },
    ],
  };
}

function serializeChunk(
  chunk: ChunkInput,
  source: Document | QdrantPayload | undefined,
  hasEmbedding: boolean,
): QdrantPayload {
  return {
    id: chunk.id,
    docId: chunk.docId,
    page: chunk.page,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    embeddingContent: chunk.embeddingContent ?? chunk.content,
    title: asString(source?.title),
    path: asString(source?.path),
    tags: asStringArray(source?.tags),
    hasEmbedding,
    embeddingOnly: false,
  };
}

function embeddingOnlyPayload(chunkId: string): QdrantPayload {
  return {
    id: chunkId,
    docId: "",
    page: 0,
    chunkIndex: 0,
    content: "",
    embeddingContent: "",
    title: "",
    path: "",
    tags: [],
    hasEmbedding: true,
    embeddingOnly: true,
  };
}

function metadataPoint(payload: QdrantPayload): QdrantUpsertPoint {
  return {
    id: toPointId(asString(payload.id)),
    vector: [0],
    payload,
  };
}

function payloadToDocument(id: string | number, payload: QdrantPayload): Document {
  const rawFileType = asString(payload.fileType);
  const fileType: DocumentFileType =
    rawFileType === "pdf" ||
    rawFileType === "markdown" ||
    rawFileType === "docx" ||
    rawFileType === "odt"
      ? rawFileType
      : inferFileTypeFromPath(asString(payload.path));

  return new Document({
    id: resolvePayloadId(id, payload),
    title: asString(payload.title),
    path: asString(payload.path),
    addedAt: new Date(asString(payload.addedAt)),
    pageCount: asNumber(payload.pageCount),
    sizeBytes: asNumber(payload.sizeBytes),
    tags: asStringArray(payload.tags),
    fileType,
    metadata: asRecord(payload.metadata),
  });
}

function payloadToChunk(id: string | number, payload: QdrantPayload): PDFChunk {
  return new PDFChunk({
    id: resolvePayloadId(id, payload),
    docId: asString(payload.docId),
    page: asNumber(payload.page),
    chunkIndex: asNumber(payload.chunkIndex),
    content: asString(payload.content),
    embeddingContent: asString(payload.embeddingContent) || undefined,
  });
}

function pointToVectorResult(point: QdrantPoint): DocumentSearchResult {
  const payload = point.payload ?? {};
  const score = typeof point.score === "number" ? point.score : 0;

  return new DocumentSearchResult({
    chunkId: resolvePayloadId(point.id, payload),
    docId: asString(payload.docId),
    title: asString(payload.title),
    page: asNumber(payload.page),
    chunkIndex: asNumber(payload.chunkIndex),
    content: asString(payload.content),
    score,
    rawScore: score,
    scoreType: "cosine_similarity",
    vectorScore: score,
    matchType: "vector",
    entityType: "document",
  });
}

function resolvePayloadId(id: string | number, payload?: QdrantPayload): string {
  const payloadId = asString(payload?.id);
  return payloadId.length > 0 ? payloadId : String(id);
}

function compareChunks(a: PDFChunk, b: PDFChunk): number {
  if (a.page !== b.page) return a.page - b.page;
  return a.chunkIndex - b.chunkIndex;
}

function fullTextRank(content: string, query: string): number {
  if (!content || !query) return 0;

  const haystack = content.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let cursor = 0;
  while (true) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    score += 1;
    cursor = index + needle.length;
  }

  return score;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isZeroVector(vector: unknown): boolean {
  if (!Array.isArray(vector)) return false;
  if (vector.length === 0) return true;
  return vector.every((value) => typeof value === "number" && Math.abs(value) < 1e-12);
}
