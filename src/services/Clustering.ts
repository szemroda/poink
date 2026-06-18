/**
 * Clustering Service
 *
 * Implements RAPTOR-style clustering on document chunk embeddings:
 * - K-means (hard clustering) - existing
 * - GMM-like soft clustering with probability-based membership
 * - BIC (Bayesian Information Criterion) for optimal cluster count
 */

import { Context, Effect, Layer } from "effect";

type Embedding = { id: string; vector: number[] };
type ClusteringComputation = {
  centroids: number[][];
  assignments: number[];
};

// ============================================================================
// Types - Hard Clustering (K-Means)
// ============================================================================

/**
 * Assignment of a document chunk to a cluster (hard assignment)
 */
export interface ClusterAssignment {
  /** Chunk ID */
  id: string;
  /** Cluster ID (0-indexed) */
  clusterId: number;
  /** Distance to cluster centroid */
  distance: number;
}

/**
 * Cluster metadata
 */
export interface Cluster {
  /** Cluster ID (0-indexed) */
  id: number;
  /** Centroid vector */
  centroid: number[];
  /** Number of members in cluster */
  size: number;
}

/**
 * Clustering result (hard clustering)
 */
export interface ClusterResult {
  /** Array of clusters with their centroids */
  clusters: Cluster[];
  /** Assignments of each embedding to a cluster */
  assignments: ClusterAssignment[];
}

/**
 * Clustering options (hard clustering)
 */
export interface ClusterOptions {
  /** Number of clusters (k) */
  k: number;
  /** Maximum iterations for k-means (default: 100) */
  maxIterations?: number;
  /**
   * Optional deterministic seed for centroid initialization.
   * Useful for reproducible runs and non-flaky tests.
   */
  seed?: number;
}

/**
 * Mini-batch k-means options
 */
export interface MiniBatchClusterOptions {
  /** Number of clusters (k) */
  k: number;
  /** Batch size for mini-batch updates (default: 100) */
  batchSize?: number;
  /** Maximum iterations (default: 100) */
  maxIterations?: number;
  /**
   * Optional deterministic seed for centroid initialization + batch sampling.
   * Useful for reproducible runs and non-flaky tests.
   */
  seed?: number;
}

// ============================================================================
// Types - Soft Clustering (GMM-like)
// ============================================================================

/**
 * Soft assignment of a chunk to a cluster with probability
 */
export interface SoftClusterAssignment {
  /** Chunk ID */
  chunkId: string;
  /** Cluster ID (0-indexed) */
  clusterId: number;
  /** Probability of belonging to this cluster (0-1) */
  probability: number;
}

/**
 * Centroid with cluster ID
 */
export interface ClusterCentroid {
  /** Cluster ID */
  clusterId: number;
  /** Centroid vector */
  vector: number[];
}

/**
 * Soft clustering result
 */
export interface SoftClusterResult {
  /** Number of clusters */
  numClusters: number;
  /** Soft assignments (multiple per chunk if probability >= minProbability) */
  softAssignments: SoftClusterAssignment[];
  /** Cluster centroids */
  centroids: ClusterCentroid[];
  /** Metadata about clustering process */
  metadata?: {
    /** BIC scores for each k tested */
    bicScores?: Array<{ k: number; bic: number }>;
    /** Selected k value */
    selectedK?: number;
  };
}

/**
 * Soft clustering options
 */
export interface SoftClusterOptions {
  /** Maximum number of clusters to try (default: 10) */
  maxClusters?: number;
  /** Minimum probability to include in assignments (default: 0.01) */
  minProbability?: number;
  /** Use BIC to select optimal k (default: true) */
  useBIC?: boolean;
  /** Maximum iterations (default: 100) */
  maxIterations?: number;
}

// ============================================================================
// Error
// ============================================================================

/**
 * Clustering error
 */
export class ClusteringError {
  readonly _tag = "ClusteringError";
  constructor(readonly reason: string) {}
}

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Service for clustering document embeddings
 */
export interface ClusteringService {
  /**
   * Cluster embeddings using k-means algorithm (hard clustering)
   */
  readonly cluster: (
    embeddings: Embedding[],
    options: ClusterOptions
  ) => Effect.Effect<ClusterResult, ClusteringError>;

  /**
   * Cluster embeddings with soft membership (GMM-like)
   * Returns probability-based assignments where chunks can belong to multiple clusters
   */
  readonly clusterSoft: (
    embeddings: Embedding[],
    options: SoftClusterOptions
  ) => Effect.Effect<SoftClusterResult, ClusteringError>;

  /**
   * Cluster embeddings using mini-batch k-means for scalability
   * Uses O(batch_size) memory instead of O(n), suitable for 500k+ embeddings
   */
  readonly clusterMiniBatch: (
    embeddings: Embedding[],
    options: MiniBatchClusterOptions
  ) => Effect.Effect<ClusterResult, ClusteringError>;
}

export const ClusteringService = Context.GenericTag<ClusteringService>(
  "@services/ClusteringService"
);

// ============================================================================
// Math Utilities
// ============================================================================

/**
 * Calculate Euclidean distance between two vectors
 */
function euclideanDistance(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((sum, val, i) => sum + (val - b[i]) ** 2, 0));
}

/**
 * Calculate mean vector from an array of vectors
 */
function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const mean = new Array(dims).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) mean[i] += v[i];
  }
  return mean.map((x) => x / vectors.length);
}

/**
 * Check if two arrays are equal
 */
function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function nearestCentroidIndex(
  vector: number[],
  centroids: number[][],
): number {
  let nearestIndex = 0;
  let nearestDistance = Infinity;

  for (let index = 0; index < centroids.length; index++) {
    const distance = euclideanDistance(vector, centroids[index]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

/**
 * Softmax function to convert distances to probabilities
 * Uses negative distances so closer = higher probability
 */
function softmax(distances: number[], temperature = 1.0): number[] {
  // Use negative distances (closer = higher score)
  const scores = distances.map((d) => -d / temperature);
  const maxScore = Math.max(...scores);
  const expScores = scores.map((s) => Math.exp(s - maxScore));
  const sumExp = expScores.reduce((a, b) => a + b, 0);
  return expScores.map((e) => e / sumExp);
}

// ============================================================================
// K-Means Algorithm
// ============================================================================

function makeSeededRng(seed: number): () => number {
  // Deterministic, fast PRNG (mulberry32). Useful for reproducible clustering.
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getRng(seed?: number): () => number {
  return typeof seed === "number" && Number.isFinite(seed)
    ? makeSeededRng(seed)
    : Math.random;
}

/**
 * K-means clustering algorithm
 */
function kMeans(
  vectors: number[][],
  k: number,
  maxIterations = 100,
  rng: () => number = Math.random
): ClusteringComputation {
  if (vectors.length === 0) {
    throw new Error("Cannot cluster empty vector array");
  }
  if (k <= 0) {
    throw new Error("k must be positive");
  }
  if (k > vectors.length) {
    throw new Error("k cannot exceed number of vectors");
  }

  // Initialize centroids with k-means++ for better convergence
  const centroids = kMeansPlusPlusInit(vectors, k, rng);
  let assignments = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign each vector to nearest centroid
    const newAssignments = vectors.map((vector) =>
      nearestCentroidIndex(vector, centroids)
    );

    // Check convergence
    if (arraysEqual(assignments, newAssignments)) break;
    assignments = newAssignments;

    // Update centroids
    for (let i = 0; i < k; i++) {
      const clusterVectors = vectors.filter((_, idx) => assignments[idx] === i);
      if (clusterVectors.length > 0) {
        centroids[i] = meanVector(clusterVectors);
      }
    }
  }

  return { centroids, assignments };
}

/**
 * K-means++ initialization for better centroid selection
 */
function kMeansPlusPlusInit(
  vectors: number[][],
  k: number,
  rng: () => number = Math.random
): number[][] {
  const centroids: number[][] = [];

  // First centroid: random
  const firstIdx = Math.floor(rng() * vectors.length);
  centroids.push([...vectors[firstIdx]]);

  // Remaining centroids: weighted by distance squared
  for (let i = 1; i < k; i++) {
    const distances = vectors.map((v) => {
      const minDist = Math.min(
        ...centroids.map((c) => euclideanDistance(v, c))
      );
      return minDist * minDist;
    });

    const totalDist = distances.reduce((a, b) => a + b, 0);
    let threshold = rng() * totalDist;

    for (let j = 0; j < vectors.length; j++) {
      threshold -= distances[j];
      if (threshold <= 0) {
        centroids.push([...vectors[j]]);
        break;
      }
    }

    // Fallback if we didn't select (shouldn't happen)
    if (centroids.length === i) {
      centroids.push([...vectors[Math.floor(rng() * vectors.length)]]);
    }
  }

  return centroids;
}

// ============================================================================
// BIC (Bayesian Information Criterion)
// ============================================================================

/**
 * Calculate BIC for a clustering result
 * Lower BIC = better model
 *
 * BIC = n * ln(RSS/n) + k * ln(n)
 * where:
 *   n = number of data points
 *   k = number of parameters (centroids * dimensions + k mixing weights)
 *   RSS = residual sum of squares
 */
function calculateBIC(
  vectors: number[][],
  centroids: number[][],
  assignments: number[]
): number {
  const n = vectors.length;
  const numClusters = centroids.length;
  const dims = vectors[0].length;

  // Calculate RSS (residual sum of squares)
  let rss = 0;
  for (let i = 0; i < n; i++) {
    rss += euclideanDistance(vectors[i], centroids[assignments[i]]) ** 2;
  }

  // Number of parameters: centroids (k * d) + mixing weights (k - 1)
  const numParams = numClusters * dims + (numClusters - 1);

  // BIC formula
  // Add small epsilon to avoid log(0)
  const bic = n * Math.log((rss + 1e-10) / n) + numParams * Math.log(n);

  return bic;
}

// ============================================================================
// Mini-Batch K-Means Algorithm
// ============================================================================

/**
 * Calculate centroid change magnitude (Frobenius norm)
 */
function centroidDelta(
  oldCentroids: number[][],
  newCentroids: number[][]
): number {
  let sumSq = 0;
  for (let i = 0; i < oldCentroids.length; i++) {
    for (let d = 0; d < oldCentroids[i].length; d++) {
      const diff = oldCentroids[i][d] - newCentroids[i][d];
      sumSq += diff * diff;
    }
  }
  return Math.sqrt(sumSq);
}

/**
 * Mini-batch k-means clustering algorithm
 * Faster and more memory-efficient than full k-means for large datasets
 *
 * Algorithm:
 * 1. Initialize centroids using k-means++
 * 2. Each iteration:
 *    - Sample a random batch of points
 *    - Assign batch points to nearest centroids
 *    - Update centroids incrementally using weighted average
 *    - Check convergence (early stopping if centroids stabilize)
 * 3. Converges when centroids stabilize or max iterations reached
 *
 * Complexity:
 * - Memory: O(batch_size) instead of O(n) - suitable for 500k+ embeddings
 * - Time: O(batch_size * k * iterations) instead of O(n * k * iterations)
 *
 * Convergence:
 * - Checks centroid stability every 10 iterations
 * - Early stopping when Frobenius norm < 1e-4
 * - Fallback to maxIterations if convergence not reached
 *
 * @param vectors - Array of embedding vectors to cluster
 * @param k - Number of clusters
 * @param batchSize - Size of random sample per iteration (default: 100)
 * @param maxIterations - Maximum iterations before stopping (default: 100)
 * @returns Object with centroids and assignment array
 * @throws Error if vectors empty, k invalid, or k > vectors.length
 */
function miniBatchKMeans(
  vectors: number[][],
  k: number,
  batchSize = 100,
  maxIterations = 100,
  rng: () => number = Math.random
): ClusteringComputation {
  if (vectors.length === 0) {
    throw new Error("Cannot cluster empty vector array");
  }
  if (k <= 0) {
    throw new Error("k must be positive");
  }
  if (k > vectors.length) {
    throw new Error("k cannot exceed number of vectors");
  }

  const n = vectors.length;
  const actualBatchSize = Math.min(batchSize, n);

  // Initialize centroids with k-means++
  const centroids = kMeansPlusPlusInit(vectors, k, rng);

  // Track per-centroid sample counts for weighted updates
  const centroidCounts = new Array(k).fill(0);

  // Convergence detection
  const convergenceThreshold = 1e-4;
  let previousCentroids = centroids.map((c) => [...c]);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Sample random batch
    const batchIndices: number[] = [];
    const batchSet = new Set<number>();

    while (batchIndices.length < actualBatchSize) {
      const idx = Math.floor(rng() * n);
      if (!batchSet.has(idx)) {
        batchSet.add(idx);
        batchIndices.push(idx);
      }
    }

    // Assign batch points to nearest centroids
    const batchAssignments = batchIndices.map((idx) =>
      nearestCentroidIndex(vectors[idx], centroids)
    );

    // Update centroids incrementally
    for (let i = 0; i < batchIndices.length; i++) {
      const vectorIdx = batchIndices[i];
      const clusterIdx = batchAssignments[i];

      centroidCounts[clusterIdx]++;
      const eta = 1 / centroidCounts[clusterIdx]; // Learning rate

      // Update centroid: c = (1 - eta) * c + eta * x
      for (let d = 0; d < centroids[clusterIdx].length; d++) {
        centroids[clusterIdx][d] =
          (1 - eta) * centroids[clusterIdx][d] + eta * vectors[vectorIdx][d];
      }
    }

    // Check convergence every 10 iterations (not every iteration for performance)
    if (iter % 10 === 0 && iter > 0) {
      const delta = centroidDelta(previousCentroids, centroids);
      if (delta < convergenceThreshold) {
        // Converged early
        break;
      }
      previousCentroids = centroids.map((c) => [...c]);
    }
  }

  // Final assignment of all points
  const assignments = vectors.map((vector) =>
    nearestCentroidIndex(vector, centroids)
  );

  return { centroids, assignments };
}

// ============================================================================
// Soft Clustering (GMM-like using K-means + Softmax)
// ============================================================================

/**
 * Perform soft clustering using k-means centroids and softmax probabilities
 * This is a simplified GMM-like approach that:
 * 1. Runs k-means to find cluster centroids
 * 2. Computes soft assignments using softmax over distances
 */
function softCluster(
  vectors: number[][],
  k: number,
  maxIterations = 100,
  temperature = 0.5
): {
  centroids: number[][];
  softAssignments: Array<{
    vectorIdx: number;
    clusterId: number;
    probability: number;
  }>;
} {
  // Run k-means to get centroids
  const { centroids } = kMeans(vectors, k, maxIterations);

  // Compute soft assignments using softmax over distances
  const softAssignments: Array<{
    vectorIdx: number;
    clusterId: number;
    probability: number;
  }> = [];

  for (let i = 0; i < vectors.length; i++) {
    const distances = centroids.map((c) => euclideanDistance(vectors[i], c));
    const probs = softmax(distances, temperature);

    for (let j = 0; j < k; j++) {
      softAssignments.push({
        vectorIdx: i,
        clusterId: j,
        probability: probs[j],
      });
    }
  }

  return { centroids, softAssignments };
}

function buildClusterResult(
  embeddings: Embedding[],
  computation: ClusteringComputation,
): ClusterResult {
  const { centroids, assignments } = computation;
  const clusterSizes = new Array<number>(centroids.length).fill(0);
  for (const clusterId of assignments) {
    clusterSizes[clusterId] += 1;
  }

  return {
    clusters: centroids.map((centroid, id) => ({
      id,
      centroid,
      size: clusterSizes[id],
    })),
    assignments: embeddings.map((embedding, index) => {
      const clusterId = assignments[index];
      return {
        id: embedding.id,
        clusterId,
        distance: euclideanDistance(embedding.vector, centroids[clusterId]),
      };
    }),
  };
}

function validateVectorDimensions(vectors: number[][]): void {
  const dimensions = vectors[0].length;
  for (let index = 1; index < vectors.length; index++) {
    if (vectors[index].length === dimensions) {
      continue;
    }
    throw new Error(
      `Dimension mismatch: vector ${index} has ${vectors[index].length} dims, expected ${dimensions}`
    );
  }
}

function selectClusterCount(
  vectors: number[][],
  maxClusters: number,
  maxIterations: number,
  useBIC: boolean,
): { selectedK: number; bicScores: Array<{ k: number; bic: number }> } {
  const maxK = Math.min(maxClusters, vectors.length);
  if (!useBIC || maxK <= 1) {
    return { selectedK: maxK, bicScores: [] };
  }

  let selectedK = 1;
  let bestBIC = Infinity;
  const bicScores: Array<{ k: number; bic: number }> = [];

  for (let k = 1; k <= maxK; k++) {
    try {
      const { centroids, assignments } = kMeans(vectors, k, maxIterations);
      const bic = calculateBIC(vectors, centroids, assignments);
      bicScores.push({ k, bic });
      if (bic < bestBIC) {
        bestBIC = bic;
        selectedK = k;
      }
    } catch {
      // Skip invalid k values.
    }
  }

  return { selectedK, bicScores };
}

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * ClusteringService implementation
 */
export const ClusteringServiceImpl = {
  Default: Layer.succeed(
    ClusteringService,
    ClusteringService.of({
      // Hard clustering (k-means)
      cluster: (embeddings, options) =>
        Effect.try({
          try: () => {
            const vectors = embeddings.map((e) => e.vector);
            const rng = getRng(options.seed);
            return buildClusterResult(
              embeddings,
              kMeans(vectors, options.k, options.maxIterations, rng),
            );
          },
          catch: (e) => new ClusteringError(String(e)),
        }),

      // Soft clustering (GMM-like)
      clusterSoft: (embeddings, options) =>
        Effect.try({
          try: () => {
            // Handle edge cases
            if (embeddings.length === 0) {
              return {
                numClusters: 0,
                softAssignments: [],
                centroids: [],
                metadata: {},
              };
            }

            if (embeddings.length === 1) {
              return {
                numClusters: 1,
                softAssignments: [
                  { chunkId: embeddings[0].id, clusterId: 0, probability: 1 },
                ],
                centroids: [{ clusterId: 0, vector: embeddings[0].vector }],
                metadata: {},
              };
            }

            const vectors = embeddings.map((e) => e.vector);
            validateVectorDimensions(vectors);

            const {
              maxClusters = 10,
              minProbability = 0.01,
              useBIC = true,
              maxIterations = 100,
            } = options;

            const { selectedK, bicScores } = selectClusterCount(
              vectors,
              maxClusters,
              maxIterations,
              useBIC,
            );

            // Run soft clustering with best k
            const { centroids, softAssignments: rawAssignments } = softCluster(
              vectors,
              selectedK,
              maxIterations
            );

            // Filter by minProbability and map to chunk IDs
            const softAssignments: SoftClusterAssignment[] = rawAssignments
              .filter((a) => a.probability >= minProbability)
              .map((a) => ({
                chunkId: embeddings[a.vectorIdx].id,
                clusterId: a.clusterId,
                probability: a.probability,
              }));

            // Build centroids
            const clusterCentroids: ClusterCentroid[] = centroids.map(
              (vector, idx) => ({
                clusterId: idx,
                vector,
              })
            );

            return {
              numClusters: selectedK,
              softAssignments,
              centroids: clusterCentroids,
              metadata: useBIC ? { bicScores, selectedK } : undefined,
            };
          },
          catch: (e) => new ClusteringError(String(e)),
        }),

      // Mini-batch k-means (scalable clustering for large datasets)
      clusterMiniBatch: (embeddings, options) =>
        Effect.try({
          try: () => {
            const vectors = embeddings.map((e) => e.vector);
            const { batchSize = 100, maxIterations = 100 } = options;
            const rng = getRng(options.seed);

            return buildClusterResult(
              embeddings,
              miniBatchKMeans(
                vectors,
                options.k,
                batchSize,
                maxIterations,
                rng
              ),
            );
          },
          catch: (e) => new ClusteringError(String(e)),
        }),
    })
  ),
};
