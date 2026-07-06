import type { Client } from "@libsql/client";
import {
  decodeMetadataValue,
  decodeTableColumn,
} from "./LibSQLRows.js";

export type LibSQLConnectionMode = "local" | "memory" | "remote";

export type EmbeddingIdentity = {
  provider?: string;
  model?: string;
};

export interface VectorSchemaManager {
  readonly ensureForEmbeddings: (
    embeddings: Array<{ embedding: number[] }>,
    identity?: EmbeddingIdentity,
  ) => Promise<void>;
  readonly ensureForDimension: (
    dimension: number,
    identity?: EmbeddingIdentity,
  ) => Promise<void>;
  readonly ensureForQuery: (dimension: number) => Promise<boolean>;
  readonly readDimension: () => Promise<number | null>;
}

export function classifyLibsqlUrl(url: string): LibSQLConnectionMode {
  if (url === ":memory:" || url.startsWith("file::memory:")) return "memory";
  if (url.startsWith("file:")) return "local";
  return "remote";
}

export async function initializeLibSQLSchema(
  client: Client,
  mode: LibSQLConnectionMode,
): Promise<void> {
  if (mode === "local") {
    await client.execute("PRAGMA busy_timeout = 30000");
    await client.execute("PRAGMA journal_mode = WAL");
  }

  await initializeDocumentSchema(client);
  await initializeTaxonomySchema(client);
  await initializeClusteringSchema(client);
  await initializeFullTextTriggers(client);
}

async function initializeDocumentSchema(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      added_at TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      tags TEXT DEFAULT '[]',
      file_type TEXT NOT NULL DEFAULT 'pdf',
      metadata TEXT DEFAULT '{}',
      source_hash_algorithm TEXT,
      source_hash TEXT,
      CHECK (
        (source_hash_algorithm IS NULL AND source_hash IS NULL)
        OR (
          source_hash_algorithm IS NOT NULL
          AND source_hash IS NOT NULL
          AND source_hash_algorithm = 'sha256'
          AND length(source_hash) = 64
          AND source_hash = lower(source_hash)
        )
      )
    )
  `);
  await ensureColumn(
    client,
    "documents",
    "file_type",
    "ALTER TABLE documents ADD COLUMN file_type TEXT NOT NULL DEFAULT 'pdf'",
    `UPDATE documents
     SET file_type = CASE
       WHEN lower(path) LIKE '%.md' OR lower(path) LIKE '%.markdown' THEN 'markdown'
       WHEN lower(path) LIKE '%.docx' THEN 'docx'
       WHEN lower(path) LIKE '%.odt' OR lower(path) LIKE '%.fodt' THEN 'odt'
       WHEN lower(path) LIKE '%.txt' THEN 'txt'
       ELSE 'pdf'
     END`,
  );
  await ensureColumn(
    client,
    "documents",
    "source_hash_algorithm",
    "ALTER TABLE documents ADD COLUMN source_hash_algorithm TEXT",
  );
  await ensureColumn(
    client,
    "documents",
    "source_hash",
    "ALTER TABLE documents ADD COLUMN source_hash TEXT",
  );
  await verifyColumns(client, "documents", [
    "id",
    "title",
    "path",
    "added_at",
    "page_count",
    "size_bytes",
    "tags",
    "file_type",
    "metadata",
    "source_hash_algorithm",
    "source_hash",
  ]);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding_content TEXT
    )
  `);
  await ensureColumn(
    client,
    "chunks",
    "embedding_content",
    "ALTER TABLE chunks ADD COLUMN embedding_content TEXT",
    "UPDATE chunks SET embedding_content = content WHERE embedding_content IS NULL",
  );
  await verifyColumns(client, "chunks", [
    "id",
    "doc_id",
    "page",
    "chunk_index",
    "content",
    "embedding_content",
  ]);

  await ensureMetadataTable(client);
  await verifyColumns(client, "library_metadata", [
    "key",
    "value",
    "updated_at",
  ]);

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_docs_path ON documents(path)",
  );
  await client.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
    USING fts5(content, content='chunks', content_rowid='rowid')
  `);
}

async function initializeTaxonomySchema(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      pref_label TEXT NOT NULL,
      alt_labels TEXT DEFAULT '[]',
      definition TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await verifyColumns(client, "concepts", [
    "id",
    "pref_label",
    "alt_labels",
    "definition",
    "created_at",
  ]);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS concept_hierarchy (
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      broader_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      PRIMARY KEY(concept_id, broader_id)
    )
  `);
  await verifyColumns(client, "concept_hierarchy", [
    "concept_id",
    "broader_id",
  ]);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS concept_relations (
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      related_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      relation_type TEXT DEFAULT 'related',
      PRIMARY KEY(concept_id, related_id)
    )
  `);
  await verifyColumns(client, "concept_relations", [
    "concept_id",
    "related_id",
    "relation_type",
  ]);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS document_concepts (
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'llm',
      PRIMARY KEY(doc_id, concept_id)
    )
  `);
  await verifyColumns(client, "document_concepts", [
    "doc_id",
    "concept_id",
    "confidence",
    "source",
  ]);

  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_concept_hierarchy_concept ON concept_hierarchy(concept_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_concept_hierarchy_broader ON concept_hierarchy(broader_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_concept_relations_concept ON concept_relations(concept_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_concept_relations_related ON concept_relations(related_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_document_concepts_doc ON document_concepts(doc_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_document_concepts_concept ON document_concepts(concept_id)",
  );
}

async function initializeClusteringSchema(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS chunk_clusters (
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      cluster_id INTEGER NOT NULL,
      distance REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(chunk_id, cluster_id)
    )
  `);
  await verifyColumns(client, "chunk_clusters", [
    "chunk_id",
    "cluster_id",
    "distance",
    "created_at",
  ]);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_chunk_clusters_cluster ON chunk_clusters(cluster_id)",
  );
}

async function initializeFullTextTriggers(client: Client): Promise<void> {
  await client.execute(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai
    AFTER INSERT ON chunks
    BEGIN
      INSERT INTO chunks_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END
  `);
  await client.execute(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad
    AFTER DELETE ON chunks
    BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content)
      VALUES('delete', old.rowid, old.content);
    END
  `);
  await client.execute(`
    CREATE TRIGGER IF NOT EXISTS chunks_au
    AFTER UPDATE ON chunks
    BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content)
      VALUES('delete', old.rowid, old.content);
      INSERT INTO chunks_fts(rowid, content)
      VALUES (new.rowid, new.content);
    END
  `);
}

export function createVectorSchemaManager(
  client: Client,
): VectorSchemaManager {
  let initialization: Promise<void> | null = null;

  const serialize = async (work: () => Promise<void>): Promise<void> => {
    while (initialization) await initialization;
    const current = work();
    initialization = current;
    try {
      await current;
    } finally {
      if (initialization === current) initialization = null;
    }
  };

  const ensureForDimension = async (
    dimension: number,
    identity?: EmbeddingIdentity,
  ): Promise<void> => {
    await serialize(async () => {
      if (!Number.isFinite(dimension) || dimension <= 0) {
        throw new Error(`Invalid embedding dimension: ${dimension}`);
      }

      const existing = await readEmbeddingDimension(client);
      if (existing !== null && existing !== dimension) {
        throw new Error(
          `Configured embedding model returns ${dimension} dimensions, but this library was initialized with ${existing}. Create a new library or rebuild with a migrated schema.`,
        );
      }

      await ensureVectorTables(client, dimension);
      if (existing === null) {
        await writeEmbeddingMetadata(client, dimension, identity);
      }
    });
  };

  return {
    ensureForEmbeddings: async (embeddings, identity) => {
      const first = embeddings[0]?.embedding;
      if (first) await ensureForDimension(first.length, identity);
    },
    ensureForDimension,
    ensureForQuery: async (dimension) => {
      const existing = await readEmbeddingDimension(client);
      if (existing === null) return false;
      await ensureForDimension(dimension);
      return true;
    },
    readDimension: () => readEmbeddingDimension(client),
  };
}

export async function tableExists(
  client: Client,
  tableName: string,
): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function ensureMetadataTable(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS library_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

async function readEmbeddingDimension(client: Client): Promise<number | null> {
  await ensureMetadataTable(client);
  const result = await client.execute({
    sql: "SELECT value FROM library_metadata WHERE key = ?",
    args: ["embedding.dimensions"],
  });
  const row = result.rows[0];
  if (!row) return null;
  const value = decodeMetadataValue(row, "read embedding dimension");
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(
      "Invalid library_metadata value for embedding.dimensions",
    );
  }
  return parsed;
}

async function writeEmbeddingMetadata(
  client: Client,
  dimension: number,
  identity?: EmbeddingIdentity,
): Promise<void> {
  const entries: Array<[string, string]> = [
    ["embedding.dimensions", String(dimension)],
  ];
  if (identity?.provider) {
    entries.push(["embedding.provider", identity.provider]);
  }
  if (identity?.model) {
    entries.push(["embedding.model", identity.model]);
  }

  await client.batch(
    entries.map(([key, value]) => ({
      sql: `INSERT INTO library_metadata (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT (key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at`,
      args: [key, value],
    })),
    "write",
  );
}

async function ensureVectorTables(
  client: Client,
  dimension: number,
): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      embedding F32_BLOB(${dimension}) NOT NULL
    )
  `);
  await verifyColumns(client, "embeddings", ["chunk_id", "embedding"]);
  await verifyVectorColumn(client, "embeddings", "embedding", dimension);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS embeddings_idx ON embeddings(libsql_vector_idx(embedding, 'compress_neighbors=float8'))",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS concept_embeddings (
      concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
      embedding F32_BLOB(${dimension}) NOT NULL
    )
  `);
  await verifyColumns(client, "concept_embeddings", [
    "concept_id",
    "embedding",
  ]);
  await verifyVectorColumn(
    client,
    "concept_embeddings",
    "embedding",
    dimension,
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS concept_embeddings_idx ON concept_embeddings(libsql_vector_idx(embedding, 'compress_neighbors=float8'))",
  );
  await client.execute(`
    CREATE TABLE IF NOT EXISTS cluster_summaries (
      id INTEGER PRIMARY KEY,
      centroid F32_BLOB(${dimension}),
      summary TEXT,
      embedding F32_BLOB(${dimension}),
      concept_id TEXT,
      concept_confidence REAL,
      chunk_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await verifyColumns(client, "cluster_summaries", [
    "id",
    "centroid",
    "summary",
    "embedding",
    "concept_id",
    "concept_confidence",
    "chunk_count",
    "created_at",
  ]);
  await verifyVectorColumn(
    client,
    "cluster_summaries",
    "centroid",
    dimension,
  );
  await verifyVectorColumn(
    client,
    "cluster_summaries",
    "embedding",
    dimension,
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_cluster_summaries_concept ON cluster_summaries(concept_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS cluster_summaries_idx ON cluster_summaries(libsql_vector_idx(embedding, 'compress_neighbors=float8'))",
  );
}

async function ensureColumn(
  client: Client,
  table: string,
  column: string,
  alterSql: string,
  backfillSql?: string,
): Promise<void> {
  const columns = await readColumns(client, table);
  if (columns.has(column)) return;
  await client.batch(
    backfillSql ? [alterSql, backfillSql] : [alterSql],
    "write",
  );
}

async function verifyColumns(
  client: Client,
  table: string,
  required: string[],
): Promise<void> {
  const columns = await readColumns(client, table);
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Incompatible libSQL schema: table ${table} is missing column(s) ${missing.join(", ")}`,
    );
  }
}

async function verifyVectorColumn(
  client: Client,
  table: string,
  column: string,
  dimension: number,
): Promise<void> {
  const columns = await readColumnDefinitions(client, table);
  const actual = columns.get(column);
  const expected = `F32_BLOB(${dimension})`;
  if (actual?.toUpperCase() !== expected) {
    throw new Error(
      `Incompatible libSQL schema: ${table}.${column} has type ${actual ?? "missing"}, expected ${expected}`,
    );
  }
}

async function readColumnDefinitions(
  client: Client,
  table: string,
): Promise<Map<string, string>> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Map(
    result.rows.map((row) => {
      const column = decodeTableColumn(row, `inspect ${table} schema`);
      return [column.name, column.type];
    }),
  );
}

async function readColumns(client: Client, table: string): Promise<Set<string>> {
  return new Set((await readColumnDefinitions(client, table)).keys());
}
