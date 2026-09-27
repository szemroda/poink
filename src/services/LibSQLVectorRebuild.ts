import type { InStatement } from "@libsql/client";
import { Effect } from "effect";
import type { LibSQLClientService } from "./LibSQLClient.js";
import { decodeConceptSourceRow } from "./LibSQLRows.js";
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
