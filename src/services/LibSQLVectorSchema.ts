import type { Client } from "@libsql/client";

export async function ensureMetadataTable(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS library_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
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

export async function readEmbeddingDimension(
  client: Client,
): Promise<number | null> {
  await ensureMetadataTable(client);
  const result = await client.execute({
    sql: "SELECT value FROM library_metadata WHERE key = ?",
    args: ["embedding.dimensions"],
  });
  const value = result.rows[0]?.value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function writeEmbeddingDimension(
  client: Client,
  dimension: number,
  embedding?: { provider?: string; model?: string },
): Promise<void> {
  await ensureMetadataTable(client);
  const entries = [
    ["embedding.dimensions", String(dimension)],
    embedding?.provider ? ["embedding.provider", embedding.provider] : null,
    embedding?.model ? ["embedding.model", embedding.model] : null,
  ].filter((entry): entry is string[] => Array.isArray(entry));

  for (const [key, value] of entries) {
    await client.execute({
      sql: `INSERT INTO library_metadata (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT (key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at`,
      args: [key, value],
    });
  }
}

export async function ensureVectorSchemaForEmbeddings(
  client: Client,
  embeddings: Array<{ embedding: number[] }>,
  embedding?: { provider?: string; model?: string },
): Promise<void> {
  const first = embeddings[0]?.embedding;
  if (!first) return;
  await ensureVectorSchemaForDimension(client, first.length, embedding);
}

export async function ensureVectorSchemaForQuery(
  client: Client,
  queryDimension: number,
): Promise<boolean> {
  const dimension = await readEmbeddingDimension(client);
  if (!dimension) return false;
  await ensureVectorSchemaForDimension(client, queryDimension);
  return true;
}

export async function ensureVectorSchemaForDimension(
  client: Client,
  dimension: number,
  embedding?: { provider?: string; model?: string },
): Promise<void> {
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error(`Invalid embedding dimension: ${dimension}`);
  }

  const existing = await readEmbeddingDimension(client);
  if (existing && existing !== dimension) {
    throw new Error(
      `Configured embedding model returns ${dimension} dimensions, but this library was initialized with ${existing}. Create a new library or rebuild with a migrated schema.`,
    );
  }

  await ensureVectorSchema(client, dimension);
  if (!existing) {
    await writeEmbeddingDimension(client, dimension, embedding);
  }
}

async function ensureVectorSchema(
  client: Client,
  embeddingDim: number,
): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      embedding F32_BLOB(${embeddingDim}) NOT NULL
    )
  `);

  await client.execute(
    `CREATE INDEX IF NOT EXISTS embeddings_idx ON embeddings(libsql_vector_idx(embedding, 'compress_neighbors=float8'))`,
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS concept_embeddings (
      concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
      embedding F32_BLOB(${embeddingDim}) NOT NULL
    )
  `);

  await client.execute(
    `CREATE INDEX IF NOT EXISTS concept_embeddings_idx ON concept_embeddings(libsql_vector_idx(embedding, 'compress_neighbors=float8'))`,
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS cluster_summaries (
      id INTEGER PRIMARY KEY,
      centroid F32_BLOB(${embeddingDim}),
      summary TEXT,
      embedding F32_BLOB(${embeddingDim}),
      concept_id TEXT,
      concept_confidence REAL,
      chunk_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_cluster_summaries_concept ON cluster_summaries(concept_id)`,
  );

  await client.execute(
    `CREATE INDEX IF NOT EXISTS cluster_summaries_idx ON cluster_summaries(libsql_vector_idx(embedding, 'compress_neighbors=float8'))`,
  );
}
