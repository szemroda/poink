import type { InStatement } from "@libsql/client";
import { Effect } from "effect";
import type { LibSQLClientService } from "./LibSQLClient.js";
import {
  decodeClusterSummarySourceRow,
  decodeConceptSourceRow,
} from "./LibSQLRows.js";
import { stagingTable, tableExists } from "./LibSQLSchema.js";
import {
  storageEffect,
  type VectorRebuildRepositoryService,
  type VectorStagingService,
} from "./StorageRepositories.js";

/** Serializes a vector after checking it fits the staging tables; libSQL does not enforce the declared dimension. */
function vectorArg(embedding: number[], dimension: number): string {
  if (embedding.length !== dimension) {
    throw new Error(
      `Rebuilt vector has ${embedding.length} dimensions, expected ${dimension}`,
    );
  }
  return JSON.stringify(embedding);
}

export function makeVectorRebuildRepository({
  client,
  vectors,
}: LibSQLClientService): VectorRebuildRepositoryService {
  const stageRows = (operation: string, build: () => InStatement[]) =>
    storageEffect(operation, async () => {
      const statements = build();
      if (statements.length > 0) await client.batch(statements, "write");
    });

  // Rows deleted while a rebuild runs are skipped here, and later deletions
  // cascade to the staging tables, so the swap never resurrects them.
  const makeStaging = (dimension: number): VectorStagingService => ({
    listEmbeddedConcepts: () =>
      storageEffect("list embedded concepts", async () => {
        if (!(await tableExists(client, "concept_embeddings"))) return [];
        const result = await client.execute(
          `SELECT c.id, c.pref_label, c.definition
           FROM concepts c
           JOIN concept_embeddings e ON e.concept_id = c.id
           ORDER BY c.id`,
        );
        return result.rows.map((row) =>
          decodeConceptSourceRow(row, "list embedded concepts"),
        );
      }),

    listClusterSummaries: () =>
      storageEffect("list cluster summaries", async () => {
        if (!(await tableExists(client, "cluster_summaries"))) return [];
        const result = await client.execute(
          "SELECT id, summary FROM cluster_summaries ORDER BY id",
        );
        return result.rows.map((row) =>
          decodeClusterSummarySourceRow(row, "list cluster summaries"),
        );
      }),

    stageChunkEmbeddings: (items) =>
      stageRows("stage chunk embeddings", () =>
        items.map((item) => ({
          sql: `INSERT INTO ${stagingTable("embeddings")} (chunk_id, embedding)
                SELECT ?, vector32(?)
                WHERE EXISTS (SELECT 1 FROM chunks WHERE id = ?)`,
          args: [
            item.chunkId,
            vectorArg(item.embedding, dimension),
            item.chunkId,
          ],
        })),
      ),

    stageConceptEmbeddings: (items) =>
      stageRows("stage concept embeddings", () =>
        items.map((item) => ({
          sql: `INSERT INTO ${stagingTable("concept_embeddings")} (concept_id, embedding)
                SELECT ?, vector32(?)
                WHERE EXISTS (SELECT 1 FROM concepts WHERE id = ?)`,
          args: [
            item.conceptId,
            vectorArg(item.embedding, dimension),
            item.conceptId,
          ],
        })),
      ),

    // Centroids are derived from old-model chunk vectors, so they are dropped.
    stageClusterSummaryEmbeddings: (items) =>
      stageRows("stage cluster summary embeddings", () =>
        items.map((item) => ({
          sql: `INSERT INTO ${stagingTable("cluster_summaries")}
                  (id, summary, embedding, concept_id, concept_confidence,
                   chunk_count, created_at)
                SELECT id, summary, ${item.embedding ? "vector32(?)" : "NULL"},
                       concept_id, concept_confidence, chunk_count, created_at
                FROM cluster_summaries WHERE id = ?`,
          args: item.embedding
            ? [vectorArg(item.embedding, dimension), item.id]
            : [item.id],
        })),
      ),
  });

  return {
    rebuildVectors: (dimension, stage) =>
      Effect.acquireUseRelease(
        storageEffect("create rebuild staging", () =>
          vectors.createStaging(dimension),
        ),
        (token) =>
          Effect.tap(stage(makeStaging(dimension)), () =>
            storageEffect("commit rebuilt vectors", () =>
              vectors.commitStaging(dimension, token),
            ),
          ),
        // A no-op after a successful commit, which releases the staging tables.
        (token) =>
          storageEffect("drop rebuild staging", () =>
            vectors.dropStaging(token),
          ).pipe(Effect.ignoreLogged),
      ),
  };
}
