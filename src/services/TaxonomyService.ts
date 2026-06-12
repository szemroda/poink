import type { InStatement, InValue } from "@libsql/client";
import { Context, Effect, Layer } from "effect";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import {
  StorageError,
  storageEffect,
} from "./StorageRepositories.js";
import { LibSQLClient } from "./LibSQLClient.js";
import {
  decodeAssignmentRow,
  decodeConceptRow,
} from "./LibSQLRows.js";

export interface Concept {
  id: string;
  prefLabel: string;
  altLabels: string[];
  definition?: string;
  createdAt: Date;
}

export interface ConceptAssignment {
  docId: string;
  conceptId: string;
  confidence: number;
  source: string;
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

export interface CreateConceptParams {
  id: string;
  prefLabel: string;
  altLabels?: string[];
  definition?: string;
}

export interface UpdateConceptParams {
  prefLabel?: string;
  altLabels?: string[];
  definition?: string;
}

export class TaxonomyError {
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
  readonly updateConcept: (
    id: string,
    updates: UpdateConceptParams,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly addBroader: (
    conceptId: string,
    broaderId: string,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly removeBroader: (
    conceptId: string,
    broaderId: string,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly getBroader: (
    conceptId: string,
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly getNarrower: (
    conceptId: string,
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly getAncestors: (
    conceptId: string,
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly getDescendants: (
    conceptId: string,
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly addRelated: (
    conceptId: string,
    relatedId: string,
    type?: string,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly removeRelated: (
    conceptId: string,
    relatedId: string,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly getRelated: (
    conceptId: string,
  ) => Effect.Effect<Concept[], TaxonomyError>;
  readonly assignToDocument: (
    docId: string,
    conceptId: string,
    confidence?: number,
    source?: string,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly removeFromDocument: (
    docId: string,
    conceptId: string,
  ) => Effect.Effect<void, TaxonomyError>;
  readonly getDocumentConcepts: (
    docId: string,
  ) => Effect.Effect<ConceptAssignment[], TaxonomyError>;
  readonly getConceptDocuments: (
    conceptId: string,
  ) => Effect.Effect<ConceptAssignment[], TaxonomyError>;
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

export function makeTaxonomyService(embeddingIdentity: {
  provider: string;
  model: string;
}) {
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

        updateConcept: (id, updates) => {
          const fields: string[] = [];
          const args: InValue[] = [];
          if (updates.prefLabel !== undefined) {
            fields.push("pref_label = ?");
            args.push(updates.prefLabel);
          }
          if (updates.altLabels !== undefined) {
            fields.push("alt_labels = ?");
            args.push(JSON.stringify(updates.altLabels));
          }
          if (updates.definition !== undefined) {
            fields.push("definition = ?");
            args.push(updates.definition);
          }
          if (fields.length === 0) return Effect.void;
          args.push(id);
          return execute(
            "update concept",
            `UPDATE concepts SET ${fields.join(", ")} WHERE id = ?`,
            args,
          ).pipe(Effect.asVoid, Effect.mapError(mapStorageError));
        },

        addBroader: (conceptId, broaderId) =>
          execute(
            "add broader concept",
            `INSERT INTO concept_hierarchy (concept_id, broader_id)
             VALUES (?, ?)
             ON CONFLICT DO NOTHING`,
            [conceptId, broaderId],
          ).pipe(Effect.asVoid, Effect.mapError(mapStorageError)),

        removeBroader: (conceptId, broaderId) =>
          execute(
            "remove broader concept",
            `DELETE FROM concept_hierarchy
             WHERE concept_id = ? AND broader_id = ?`,
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

        getAncestors: (conceptId) =>
          readConcepts(
            "get concept ancestors",
            `WITH RECURSIVE ancestors AS (
               SELECT broader_id
               FROM concept_hierarchy
               WHERE concept_id = ?
               UNION
               SELECT ch.broader_id
               FROM concept_hierarchy ch
               JOIN ancestors a ON ch.concept_id = a.broader_id
             )
             SELECT c.* FROM concepts c
             WHERE c.id IN (SELECT broader_id FROM ancestors)`,
            [conceptId],
          ).pipe(Effect.mapError(mapStorageError)),

        getDescendants: (conceptId) =>
          readConcepts(
            "get concept descendants",
            `WITH RECURSIVE descendants AS (
               SELECT concept_id
               FROM concept_hierarchy
               WHERE broader_id = ?
               UNION
               SELECT ch.concept_id
               FROM concept_hierarchy ch
               JOIN descendants d ON ch.broader_id = d.concept_id
             )
             SELECT c.* FROM concepts c
             WHERE c.id IN (SELECT concept_id FROM descendants)`,
            [conceptId],
          ).pipe(Effect.mapError(mapStorageError)),

        addRelated: (conceptId, relatedId, type = "related") =>
          batch("add related concepts", [
            {
              sql: `INSERT INTO concept_relations
                      (concept_id, related_id, relation_type)
                    VALUES (?, ?, ?)
                    ON CONFLICT DO NOTHING`,
              args: [conceptId, relatedId, type],
            },
            {
              sql: `INSERT INTO concept_relations
                      (concept_id, related_id, relation_type)
                    VALUES (?, ?, ?)
                    ON CONFLICT DO NOTHING`,
              args: [relatedId, conceptId, type],
            },
          ]).pipe(Effect.mapError(mapStorageError)),

        removeRelated: (conceptId, relatedId) =>
          batch("remove related concepts", [
            {
              sql: `DELETE FROM concept_relations
                    WHERE concept_id = ? AND related_id = ?`,
              args: [conceptId, relatedId],
            },
            {
              sql: `DELETE FROM concept_relations
                    WHERE concept_id = ? AND related_id = ?`,
              args: [relatedId, conceptId],
            },
          ]).pipe(Effect.mapError(mapStorageError)),

        getRelated: (conceptId) =>
          readConcepts(
            "get related concepts",
            `SELECT c.* FROM concepts c
             JOIN concept_relations cr ON c.id = cr.related_id
             WHERE cr.concept_id = ?`,
            [conceptId],
          ).pipe(Effect.mapError(mapStorageError)),

        assignToDocument: (
          docId,
          conceptId,
          confidence = 1,
          source = "llm",
        ) =>
          execute(
            "assign concept to document",
            `INSERT INTO document_concepts
               (doc_id, concept_id, confidence, source)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (doc_id, concept_id) DO UPDATE SET
               confidence = excluded.confidence,
               source = excluded.source`,
            [docId, conceptId, confidence, source],
          ).pipe(Effect.asVoid, Effect.mapError(mapStorageError)),

        removeFromDocument: (docId, conceptId) =>
          execute(
            "remove concept from document",
            `DELETE FROM document_concepts
             WHERE doc_id = ? AND concept_id = ?`,
            [docId, conceptId],
          ).pipe(Effect.asVoid, Effect.mapError(mapStorageError)),

        getDocumentConcepts: (docId) =>
          execute(
            "get document concepts",
            "SELECT * FROM document_concepts WHERE doc_id = ?",
            [docId],
          ).pipe(
            Effect.map((result) =>
              result.rows.map((row) =>
                decodeAssignmentRow(row, "get document concepts"),
              ),
            ),
            Effect.mapError(mapStorageError),
          ),

        getConceptDocuments: (conceptId) =>
          execute(
            "get concept documents",
            "SELECT * FROM document_concepts WHERE concept_id = ?",
            [conceptId],
          ).pipe(
            Effect.map((result) =>
              result.rows.map((row) =>
                decodeAssignmentRow(row, "get concept documents"),
              ),
            ),
            Effect.mapError(mapStorageError),
          ),

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
              await vectors.ensureForDimension(
                embedding.length,
                embeddingIdentity,
              );
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

export const generateConceptEmbedding = (concept: Concept) =>
  Effect.gen(function* () {
    const embedProvider = yield* EmbeddingProvider;
    const text = concept.definition
      ? `${concept.prefLabel}: ${concept.definition}`
      : concept.prefLabel;
    return yield* embedProvider.embed(text);
  }).pipe(
    Effect.mapError(
      (error): TaxonomyError =>
        new TaxonomyError(`Failed to generate embedding: ${String(error)}`),
    ),
  );
