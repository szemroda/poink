import type { InStatement, InValue } from "@libsql/client";
import { Context, Effect, Layer } from "effect";
import {
  StorageError,
  storageEffect,
} from "./StorageRepositories.js";
import { LibSQLClient } from "./LibSQLClient.js";
import { decodeConceptRow } from "./LibSQLRows.js";

export interface Concept {
  id: string;
  prefLabel: string;
  altLabels: string[];
  definition?: string;
  createdAt: Date;
}

export interface TaxonomyJSON {
  concepts: Array<{
    id: string;
    prefLabel: string;
    altLabels?: string[];
    definition?: string;
  }>;
  hierarchy?: Array<{
    conceptId: string;
    broaderId: string;
  }>;
  relations?: Array<{
    conceptId: string;
    relatedId: string;
    relationType?: string;
  }>;
}

interface CreateConceptParams {
  id: string;
  prefLabel: string;
  altLabels?: string[];
  definition?: string;
}

class TaxonomyError {
  readonly _tag = "TaxonomyError";
  constructor(readonly reason: string) {}
}

export interface TaxonomyService {
  readonly addConcept: (
    params: CreateConceptParams,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly getConcept: (
    id: string,
  ) => Effect.Effect<Concept | null, TaxonomyError>;
  readonly listConcepts: () => Effect.Effect<Concept[], TaxonomyError>;
  readonly addBroader: (
    conceptId: string,
    broaderId: string,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly getBroader: (
    conceptId: string,
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly getNarrower: (
    conceptId: string,
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly getRelated: (
    conceptId: string,
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly assignToDocument: (
    docId: string,
    conceptId: string,
    confidence?: number,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly seedFromJSON: (
    taxonomy: TaxonomyJSON,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly storeConceptEmbedding: (
    conceptId: string,
    embedding: number[],
  ) => Effect.Effect<void, TaxonomyError>;
  readonly findSimilarConcepts: (
    embedding: number[],
    threshold?: number,
    limit?: number,
  ) => Effect.Effect<Concept[], TaxonomyError>;
}

export const TaxonomyService = Context.GenericTag<TaxonomyService>(
  "@services/TaxonomyService",
);

function mapStorageError(error: StorageError): TaxonomyError {
  return new TaxonomyError(`${error.operation}: ${error.reason}`);
}

export function makeTaxonomyService() {
  return Layer.effect(
    TaxonomyService,
    Effect.gen(function* () {
      const { client, vectors } = yield* LibSQLClient;

      const execute = (
        operation: string,
        sql: string,
        args: InValue[] = [],
      ) => storageEffect(operation, () => client.execute({ sql, args }));

      const batch = (operation: string, statements: InStatement[]) =>
        storageEffect(operation, async () => {
          if (statements.length > 0) {
            await client.batch(statements, "write");
          }
        });

      const readConcepts = (operation: string, sql: string, args: InValue[]) =>
        Effect.map(execute(operation, sql, args), (result) =>
          result.rows.map((row) => decodeConceptRow(row, operation)),
        );

      return TaxonomyService.of({
        addConcept: (params) =>
          execute(
            "add concept",
            `INSERT INTO concepts
               (id, pref_label, alt_labels, definition, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [
              params.id,
              params.prefLabel,
              JSON.stringify(params.altLabels ?? []),
              params.definition ?? null,
              new Date().toISOString(),
            ],
          ).pipe(Effect.asVoid, Effect.mapError(mapStorageError)),

        getConcept: (id) =>
          readConcepts(
            "get concept",
            "SELECT * FROM concepts WHERE id = ?",
            [id],
          ).pipe(
            Effect.map((concepts) => concepts[0] ?? null),
            Effect.mapError(mapStorageError),
          ),

        listConcepts: () =>
          readConcepts(
            "list concepts",
            "SELECT * FROM concepts ORDER BY pref_label ASC",
            [],
          ).pipe(Effect.mapError(mapStorageError)),

        addBroader: (conceptId, broaderId) =>
          execute(
            "add broader concept",
            `INSERT INTO concept_hierarchy (concept_id, broader_id)
             VALUES (?, ?)
             ON CONFLICT DO NOTHING`,
            [conceptId, broaderId],
          ).pipe(Effect.asVoid, Effect.mapError(mapStorageError)),

        getBroader: (conceptId) =>
          readConcepts(
            "get broader concepts",
            `SELECT c.* FROM concepts c
             JOIN concept_hierarchy ch ON c.id = ch.broader_id
             WHERE ch.concept_id = ?`,
            [conceptId],
          ).pipe(Effect.mapError(mapStorageError)),

        getNarrower: (conceptId) =>
          readConcepts(
            "get narrower concepts",
            `SELECT c.* FROM concepts c
             JOIN concept_hierarchy ch ON c.id = ch.concept_id
             WHERE ch.broader_id = ?`,
            [conceptId],
          ).pipe(Effect.mapError(mapStorageError)),

        getRelated: (conceptId) =>
          readConcepts(
            "get related concepts",
            `SELECT c.* FROM concepts c
             JOIN concept_relations cr ON c.id = cr.related_id
             WHERE cr.concept_id = ?`,
            [conceptId],
          ).pipe(Effect.mapError(mapStorageError)),

        assignToDocument: (docId, conceptId, confidence = 1) =>
          execute(
            "assign concept to document",
            `INSERT INTO document_concepts
               (doc_id, concept_id, confidence, source)
             VALUES (?, ?, ?, 'llm')
             ON CONFLICT (doc_id, concept_id) DO UPDATE SET
               confidence = excluded.confidence,
               source = excluded.source`,
            [docId, conceptId, confidence],
          ).pipe(Effect.asVoid, Effect.mapError(mapStorageError)),

        seedFromJSON: (taxonomy) => {
          const timestamp = new Date().toISOString();
          const statements: InStatement[] = taxonomy.concepts.map(
            (concept) => ({
              sql: `INSERT INTO concepts
                      (id, pref_label, alt_labels, definition, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT DO NOTHING`,
              args: [
                concept.id,
                concept.prefLabel,
                JSON.stringify(concept.altLabels ?? []),
                concept.definition ?? null,
                timestamp,
              ],
            }),
          );
          for (const relation of taxonomy.hierarchy ?? []) {
            statements.push({
              sql: `INSERT INTO concept_hierarchy (concept_id, broader_id)
                    VALUES (?, ?)
                    ON CONFLICT DO NOTHING`,
              args: [relation.conceptId, relation.broaderId],
            });
          }
          for (const relation of taxonomy.relations ?? []) {
            const type = relation.relationType ?? "related";
            statements.push(
              {
                sql: `INSERT INTO concept_relations
                        (concept_id, related_id, relation_type)
                      VALUES (?, ?, ?)
                      ON CONFLICT DO NOTHING`,
                args: [relation.conceptId, relation.relatedId, type],
              },
              {
                sql: `INSERT INTO concept_relations
                        (concept_id, related_id, relation_type)
                      VALUES (?, ?, ?)
                      ON CONFLICT DO NOTHING`,
                args: [relation.relatedId, relation.conceptId, type],
              },
            );
          }
          return batch("seed taxonomy", statements).pipe(
            Effect.mapError(mapStorageError),
          );
        },

        storeConceptEmbedding: (conceptId, embedding) =>
          Effect.tryPromise({
            try: async () => {
              await vectors.ensureForDimension(embedding.length);
              await client.execute({
                sql: `INSERT INTO concept_embeddings (concept_id, embedding)
                      VALUES (?, vector32(?))
                      ON CONFLICT (concept_id) DO UPDATE SET
                        embedding = excluded.embedding`,
                args: [conceptId, JSON.stringify(embedding)],
              });
            },
            catch: (error) =>
              new TaxonomyError(
                error instanceof Error ? error.message : String(error),
              ),
          }),

        findSimilarConcepts: (embedding, threshold = 0.85, limit = 5) =>
          Effect.tryPromise({
            try: async () => {
              if (!(await vectors.ensureForQuery(embedding.length))) return [];
              const queryVector = JSON.stringify(embedding);
              const result = await client.execute({
                sql: `SELECT
                        c.id,
                        c.pref_label,
                        c.alt_labels,
                        c.definition,
                        c.created_at,
                        vector_distance_cos(
                          e.embedding,
                          vector32(?)
                        ) AS distance
                      FROM vector_top_k(
                        'concept_embeddings_idx',
                        vector32(?),
                        ?
                      ) AS top
                      JOIN concept_embeddings e ON e.rowid = top.id
                      JOIN concepts c ON c.id = e.concept_id
                      WHERE vector_distance_cos(
                        e.embedding,
                        vector32(?)
                      ) <= ?
                      ORDER BY distance ASC`,
                args: [
                  queryVector,
                  queryVector,
                  limit * 2,
                  queryVector,
                  2 * (1 - threshold),
                ],
              });
              return result.rows.map((row) =>
                decodeConceptRow(row, "find similar concepts"),
              );
            },
            catch: (error) =>
              new TaxonomyError(
                error instanceof Error ? error.message : String(error),
              ),
          }),
      });
    }),
  );
}
