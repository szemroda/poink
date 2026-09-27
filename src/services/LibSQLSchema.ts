import { randomUUID } from "node:crypto";
import type {
  Client,
  InStatement,
  ResultSet,
  Transaction,
} from "@libsql/client";
import {
  decodeCountRow,
  decodeMetadataValue,
  decodeTableColumn,
} from "./LibSQLRows.js";

/** A client or an open transaction. */
type Executor = { execute(statement: InStatement): Promise<ResultSet> };

export type LibSQLConnectionMode = "local" | "memory" | "remote";

type EmbeddingIdentity = {
  provider: string;
  model: string;
};

/**
 * Guards every vector collection against incompatible embeddings. Writes and
 * queries must match the library's dimension and embedding model identity.
 */
export interface VectorSchemaManager {
  readonly ensureForEmbeddings: (
    embeddings: Array<{ embedding: number[] }>,
  ) => Promise<void>;
  readonly ensureForDimension: (dimension: number) => Promise<void>;
  readonly ensureForQuery: (dimension: number) => Promise<boolean>;
  /** Recreates vector tables for an existing library without identity checks. */
  readonly restoreStoredSchema: () => Promise<void>;
  /**
   * Creates empty staging vector tables and returns the rebuild's owner token.
   * Starting a rebuild takes over the staging tables of any earlier one.
   */
  readonly createStaging: (dimension: number) => Promise<string>;
  /**
   * Replaces the live vector tables with the staged ones and records the
   * configured identity in one transaction. Throws, changing nothing, when a
   * newer rebuild owns the staging tables or when a live chunk or concept
   * vector has no staged replacement.
   */
  readonly commitStaging: (dimension: number, token: string) => Promise<void>;
  /** Drops the staging tables if the rebuild identified by `token` still owns them. */
  readonly dropStaging: (token: string) => Promise<void>;
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
    "CREATE INDEX IF NOT EXISTS idx_chunks_doc_position ON chunks(doc_id, page, chunk_index)",
  );
  await client.execute("DROP INDEX IF EXISTS idx_chunks_doc");
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
  identity: EmbeddingIdentity,
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

  /** Queries validate compatibility but never write library metadata. */
  const ensureCompatible = async (
    dimension: number,
    access: "write" | "query",
  ): Promise<void> => {
    await serialize(async () => {
      if (!Number.isFinite(dimension) || dimension <= 0) {
        throw new Error(`Invalid embedding dimension: ${dimension}`);
      }

      const existing = await readEmbeddingDimension(client);
      if (existing !== null && existing !== dimension) {
        throw new Error(
          `Configured embedding model returns ${dimension} dimensions, but this library's vectors have ${existing}. Run \`poink reindex\` to rebuild every vector with the configured model.`,
        );
      }

      const stored = await readEmbeddingIdentity(client);
      if (
        stored &&
        (stored.provider !== identity.provider ||
          stored.model !== identity.model)
      ) {
        throw new Error(
          `Configured embedding model ${identity.provider}/${identity.model} differs from ${stored.provider}/${stored.model}, which built this library's vectors. Vectors from different models are not comparable. Run \`poink reindex\` to rebuild every vector with the configured model, or configure ${stored.provider}/${stored.model} again.`,
        );
      }

      if (access === "query") return;
      await ensureVectorTables(client, dimension);
      // Libraries created before identity tracking adopt the model that
      // performs their next write.
      if (existing === null || stored === null) {
        await writeEmbeddingMetadata(client, dimension, identity);
      }
    });
  };
  const ensureForDimension = (dimension: number) =>
    ensureCompatible(dimension, "write");

  return {
    ensureForEmbeddings: async (embeddings) => {
      const first = embeddings[0]?.embedding;
      if (first) await ensureForDimension(first.length);
    },
    ensureForDimension,
    ensureForQuery: async (dimension) => {
      const existing = await readEmbeddingDimension(client);
      if (existing === null) return false;
      await ensureCompatible(dimension, "query");
      return true;
    },
    restoreStoredSchema: () =>
      serialize(async () => {
        const existing = await readEmbeddingDimension(client);
        if (existing !== null) await ensureVectorTables(client, existing);
      }),
    createStaging: async (dimension) => {
      const token = randomUUID();
      await serialize(async () => {
        await ensureMetadataTable(client);
        await client.batch(
          [
            ...dropStagingStatements(),
            ...VECTOR_TABLE_NAMES.map((table) => {
              const spec: VectorTableSpec = VECTOR_TABLES[table];
              return `CREATE TABLE ${stagingTable(table)} (${spec.columns(dimension)})`;
            }),
            metadataUpsert(REBUILD_OWNER_KEY, token),
          ],
          "write",
        );
      });
      return token;
    },
    commitStaging: (dimension, token) =>
      serialize(async () => {
        await ensureMetadataTable(client);
        const tx = await client.transaction("write");
        try {
          if ((await readMetadataValue(tx, REBUILD_OWNER_KEY)) !== token) {
            throw new Error(
              "A newer rebuild replaced this rebuild's staged vectors. Let it finish, or run `poink reindex` again.",
            );
          }
          const unstaged = await countUnstagedVectors(tx);
          if (unstaged > 0) {
            throw new Error(
              `The library changed during the rebuild: ${unstaged} chunk(s) or concept(s) have no rebuilt vector. Run the rebuild again.`,
            );
          }
          for (const table of VECTOR_TABLE_NAMES) {
            await tx.execute(`DROP TABLE IF EXISTS ${table}`);
            await tx.execute(
              `ALTER TABLE ${stagingTable(table)} RENAME TO ${table}`,
            );
            for (const index of VECTOR_TABLES[table].indexes) {
              await tx.execute(index);
            }
          }
          await tx.batch([
            ...embeddingMetadataStatements(dimension, identity),
            RELEASE_REBUILD_OWNER,
          ]);
          await tx.commit();
        } finally {
          tx.close();
        }
      }),
    dropStaging: (token) =>
      serialize(async () => {
        await ensureMetadataTable(client);
        const tx = await client.transaction("write");
        try {
          if ((await readMetadataValue(tx, REBUILD_OWNER_KEY)) !== token) return;
          await tx.batch([...dropStagingStatements(), RELEASE_REBUILD_OWNER]);
          await tx.commit();
        } finally {
          tx.close();
        }
      }),
  };
}

/** Metadata key naming the rebuild that owns the staging tables. */
const REBUILD_OWNER_KEY = "rebuild.owner";

const RELEASE_REBUILD_OWNER: InStatement = {
  sql: "DELETE FROM library_metadata WHERE key = ?",
  args: [REBUILD_OWNER_KEY],
};

function dropStagingStatements(): string[] {
  return VECTOR_TABLE_NAMES.map(
    (table) => `DROP TABLE IF EXISTS ${stagingTable(table)}`,
  );
}

export async function tableExists(
  client: Executor,
  tableName: string,
): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function ensureMetadataTable(client: Executor): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS library_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

async function readMetadataValue(
  client: Executor,
  key: string,
): Promise<string | null> {
  await ensureMetadataTable(client);
  const result = await client.execute({
    sql: "SELECT value FROM library_metadata WHERE key = ?",
    args: [key],
  });
  const row = result.rows[0];
  return row ? decodeMetadataValue(row, `read ${key}`) : null;
}

async function readEmbeddingDimension(client: Client): Promise<number | null> {
  const value = await readMetadataValue(client, "embedding.dimensions");
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(
      "Invalid library_metadata value for embedding.dimensions",
    );
  }
  return parsed;
}

/** Returns the stored identity, or null for libraries created before it was tracked. */
async function readEmbeddingIdentity(
  client: Client,
): Promise<EmbeddingIdentity | null> {
  const provider = await readMetadataValue(client, "embedding.provider");
  const model = await readMetadataValue(client, "embedding.model");
  return provider && model ? { provider, model } : null;
}

function embeddingMetadataStatements(
  dimension: number,
  identity: EmbeddingIdentity,
): InStatement[] {
  const entries: Array<[string, string]> = [
    ["embedding.dimensions", String(dimension)],
    ["embedding.provider", identity.provider],
    ["embedding.model", identity.model],
  ];
  return entries.map(([key, value]) => metadataUpsert(key, value));
}

function metadataUpsert(key: string, value: string): InStatement {
  return {
    sql: `INSERT INTO library_metadata (key, value, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT (key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at`,
    args: [key, value],
  };
}

async function writeEmbeddingMetadata(
  client: Client,
  dimension: number,
  identity: EmbeddingIdentity,
): Promise<void> {
  await client.batch(embeddingMetadataStatements(dimension, identity), "write");
}

type VectorTableSpec = {
  columns: (dimension: number) => string;
  columnNames: readonly string[];
  vectorColumns: readonly string[];
  indexes: readonly string[];
};

const VECTOR_TABLES = {
  embeddings: {
    columns: (dimension) => `
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      embedding F32_BLOB(${dimension}) NOT NULL`,
    columnNames: ["chunk_id", "embedding"],
    vectorColumns: ["embedding"],
    indexes: [
      "CREATE INDEX IF NOT EXISTS embeddings_idx ON embeddings(libsql_vector_idx(embedding, 'compress_neighbors=float8'))",
    ],
  },
  concept_embeddings: {
    columns: (dimension) => `
      concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
      embedding F32_BLOB(${dimension}) NOT NULL`,
    columnNames: ["concept_id", "embedding"],
    vectorColumns: ["embedding"],
    indexes: [
      "CREATE INDEX IF NOT EXISTS concept_embeddings_idx ON concept_embeddings(libsql_vector_idx(embedding, 'compress_neighbors=float8'))",
    ],
  },
} satisfies Record<string, VectorTableSpec>;

type VectorTable = keyof typeof VECTOR_TABLES;

const VECTOR_TABLE_NAMES = Object.keys(VECTOR_TABLES) as VectorTable[];

/** The table that holds a vector table's replacement during a rebuild. */
export function stagingTable(table: VectorTable): string {
  return `${table}_rebuild`;
}

async function ensureVectorTables(
  client: Client,
  dimension: number,
): Promise<void> {
  for (const table of VECTOR_TABLE_NAMES) {
    const spec: VectorTableSpec = VECTOR_TABLES[table];
    await client.execute(
      `CREATE TABLE IF NOT EXISTS ${table} (${spec.columns(dimension)})`,
    );
    await verifyColumns(client, table, [...spec.columnNames]);
    for (const column of spec.vectorColumns) {
      await verifyVectorColumn(client, table, column, dimension);
    }
    for (const index of spec.indexes) await client.execute(index);
  }
}

/** Counts live rows that a staged rebuild would drop because they have no staged vector. */
async function countUnstagedVectors(tx: Transaction): Promise<number> {
  const chunks = await tx.execute(`
    SELECT COUNT(c.id) AS count FROM chunks c
    JOIN documents d ON d.id = c.doc_id
    WHERE NOT EXISTS (
      SELECT 1 FROM ${stagingTable("embeddings")} s WHERE s.chunk_id = c.id
    )`);
  let unstaged = decodeCountRow(chunks.rows[0], "verify rebuilt vectors");
  if (await tableExists(tx, "concept_embeddings")) {
    const concepts = await tx.execute(`
      SELECT COUNT(e.concept_id) AS count FROM concept_embeddings e
      WHERE NOT EXISTS (
        SELECT 1 FROM ${stagingTable("concept_embeddings")} s
        WHERE s.concept_id = e.concept_id
      )`);
    unstaged += decodeCountRow(concepts.rows[0], "verify rebuilt vectors");
  }
  return unstaged;
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
