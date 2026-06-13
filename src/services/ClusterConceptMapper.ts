import { Context, Effect, Layer } from "effect";

/**
 * Input cluster with centroid embedding
 */
export interface ClusterInput {
  id: number;
  summary: string;
  centroid: number[];
}

/**
 * SKOS concept with embedding
 */
export interface ConceptInput {
  id: string;
  label: string;
  embedding: number[];
}

/**
 * Result of mapping a cluster to concepts
 */
export interface MapResult {
  clusterId: number;
  matched: boolean;
  conceptId?: string;
  confidence?: number;
  suggestedLabel?: string;
}

/**
 * Options for cluster mapping
 */
export interface MapOptions {
  threshold: number;
}

/**
 * Service for mapping document clusters to SKOS concepts
 */
export interface ClusterConceptMapperService {
  readonly mapCluster: (
    cluster: ClusterInput,
    concepts: ConceptInput[],
    options: MapOptions
  ) => Effect.Effect<MapResult, ClusterConceptMapperError>;
}

export class ClusterConceptMapperError {
  readonly _tag = "ClusterConceptMapperError";
  constructor(readonly reason: string) {}
}

export const ClusterConceptMapperService =
  Context.GenericTag<ClusterConceptMapperService>(
    "@services/ClusterConceptMapperService"
  );

interface ConceptMatch {
  conceptId: string;
  confidence: number;
}

const SUGGESTED_LABEL_MAX_LENGTH = 50;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function findBestMatch(
  centroid: number[],
  concepts: ConceptInput[],
  threshold: number
): ConceptMatch | undefined {
  let bestMatch: ConceptMatch | undefined;

  for (const concept of concepts) {
    const confidence = cosineSimilarity(centroid, concept.embedding);
    if (!(confidence >= threshold)) {
      continue;
    }
    if (bestMatch && confidence <= bestMatch.confidence) {
      continue;
    }

    bestMatch = {
      conceptId: concept.id,
      confidence,
    };
  }

  return bestMatch;
}

function createMatchedResult(
  clusterId: number,
  match: ConceptMatch
): MapResult {
  return {
    clusterId,
    matched: true,
    conceptId: match.conceptId,
    confidence: match.confidence,
  };
}

function createSuggestedResult(cluster: ClusterInput): MapResult {
  return {
    clusterId: cluster.id,
    matched: false,
    suggestedLabel: cluster.summary
      .split(/[.!?]/)[0]
      .slice(0, SUGGESTED_LABEL_MAX_LENGTH),
  };
}

function mapClusterToConcept(
  cluster: ClusterInput,
  concepts: ConceptInput[],
  options: MapOptions
): MapResult {
  const bestMatch = findBestMatch(
    cluster.centroid,
    concepts,
    options.threshold
  );
  if (!bestMatch) {
    return createSuggestedResult(cluster);
  }

  return createMatchedResult(cluster.id, bestMatch);
}

export class ClusterConceptMapperImpl {
  static Default = Layer.succeed(
    ClusterConceptMapperService,
    ClusterConceptMapperService.of({
      mapCluster: (cluster, concepts, options) =>
        Effect.try({
          try: () => mapClusterToConcept(cluster, concepts, options),
          catch: (error) => new ClusterConceptMapperError(String(error)),
        }),
    })
  );
}
