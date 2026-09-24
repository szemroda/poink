import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  ClusteringService,
  ClusteringServiceImpl,
  ClusteringError,
} from "./Clustering.js";

type Embedding = { id: string; vector: number[] };

function runClustering<A, E>(
  operation: (service: ClusteringService) => Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(
    Effect.flatMap(ClusteringService, operation).pipe(
      Effect.provide(ClusteringServiceImpl.Default),
    ),
  );
}

function clusteringFailure(
  operation: (service: ClusteringService) => Effect.Effect<unknown, ClusteringError>,
): Promise<ClusteringError> {
  return runClustering((service) => Effect.flip(operation(service)));
}

/** Deterministic PRNG (mulberry32) so fixtures don't depend on Math.random. */
function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds `numClusters` well-separated groups of `numPerCluster` noisy points,
 * each centred on the unit vector of dimension `cluster * spacing`.
 */
function generateTestEmbeddings(
  numPerCluster: number,
  dims: number,
  { numClusters = 3, spacing = 1, noise = 0.2, seed = 42 } = {},
): Embedding[] {
  const rand = makeSeededRng(seed);
  return Array.from({ length: numClusters * numPerCluster }, (_, index) => {
    const cluster = Math.floor(index / numPerCluster);
    return {
      id: `chunk-${cluster}-${index % numPerCluster}`,
      vector: Array.from({ length: dims }, (_, d) =>
        (d === cluster * spacing ? 1 : 0) + rand() * noise,
      ),
    };
  });
}

describe("ClusteringService - K-Means", () => {
  it("preserves seeded k-means++ centroid selection", async () => {
    const embeddings = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      vector: [index % 4, Math.floor(index / 4), index / 10],
    }));
    const result = await runClustering((service) =>
      service.cluster(embeddings, { k: 4, maxIterations: 0, seed: 123 }),
    );

    expect(result.clusters.map((cluster) => cluster.centroid)).toEqual([
      [1, 2, 0.9],
      [1, 0, 0.1],
      [2, 1, 0.6],
      [3, 0, 0.3],
    ]);
  });

  it("groups similar vectors and reports distances to their centroid", async () => {
    const result = await runClustering((service) =>
      service.cluster(
        [
          { id: "1", vector: [1, 0, 0] },
          { id: "2", vector: [0.9, 0.1, 0] },
          { id: "3", vector: [0, 1, 0] },
          { id: "4", vector: [0.1, 0.9, 0] },
        ],
        { k: 2, seed: 1 },
      ),
    );

    const [a1, a2, b1, b2] = result.assignments;
    expect(a1.clusterId).toBe(a2.clusterId);
    expect(b1.clusterId).toBe(b2.clusterId);
    expect(a1.clusterId).not.toBe(b1.clusterId);
    expect(result.clusters.map((cluster) => cluster.size)).toEqual([2, 2]);
    for (const assignment of result.assignments) {
      expect(assignment.distance).toBeCloseTo(Math.hypot(0.05, 0.05));
    }
  });

  it("assigns everything to a single cluster when k is 1", async () => {
    const result = await runClustering((service) =>
      service.cluster(
        [
          { id: "1", vector: [1, 0] },
          { id: "2", vector: [2, 0] },
        ],
        { k: 1 },
      ),
    );

    expect(result.clusters).toHaveLength(1);
    expect(result.assignments.map((assignment) => assignment.clusterId)).toEqual([0, 0]);
  });
});

describe("ClusteringService - Soft Clustering", () => {
  it("returns probability-weighted assignments and one centroid per cluster", async () => {
    const result = await runClustering((service) =>
      service.clusterSoft(generateTestEmbeddings(10, 4), {
        maxClusters: 5,
        minProbability: 0.01,
      }),
    );

    expect(result.numClusters).toBeGreaterThanOrEqual(2);
    expect(result.numClusters).toBeLessThanOrEqual(5);
    expect(result.centroids.map((centroid) => centroid.clusterId)).toEqual(
      Array.from({ length: result.numClusters }, (_, index) => index),
    );
    for (const centroid of result.centroids) {
      expect(centroid.vector).toHaveLength(4);
    }
    expect(result.softAssignments.length).toBeGreaterThan(0);
    for (const assignment of result.softAssignments) {
      expect(assignment.clusterId).toBeLessThan(result.numClusters);
      expect(assignment.probability).toBeGreaterThanOrEqual(0.01);
      expect(assignment.probability).toBeLessThanOrEqual(1);
    }
  });

  it("lets a point between clusters belong to both", async () => {
    const result = await runClustering((service) =>
      service.clusterSoft(
        [
          { id: "a1", vector: [1, 0, 0, 0] },
          { id: "a2", vector: [0.95, 0.05, 0, 0] },
          { id: "b1", vector: [0, 1, 0, 0] },
          { id: "b2", vector: [0.05, 0.95, 0, 0] },
          { id: "overlap", vector: [0.5, 0.5, 0, 0] },
        ],
        { maxClusters: 2, minProbability: 0.1, useBIC: false },
      ),
    );

    expect(result.numClusters).toBe(2);
    expect(result.metadata).toBeUndefined();
    const overlap = result.softAssignments.filter((a) => a.chunkId === "overlap");
    expect(overlap.map((a) => a.clusterId).sort()).toEqual([0, 1]);
    expect(overlap[0].probability + overlap[1].probability).toBeCloseTo(1);
  });

  it("uses BIC to select the cluster count", async () => {
    const result = await runClustering((service) =>
      service.clusterSoft(generateTestEmbeddings(15, 4), {
        maxClusters: 8,
        useBIC: true,
      }),
    );

    expect(result.numClusters).toBeGreaterThanOrEqual(2);
    expect(result.numClusters).toBeLessThanOrEqual(6);
    expect(result.metadata?.selectedK).toBe(result.numClusters);
    expect(result.metadata?.bicScores?.map((score) => score.k)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("handles empty input", async () => {
    const result = await runClustering((service) =>
      service.clusterSoft([], { maxClusters: 3 }),
    );

    expect(result).toMatchObject({ numClusters: 0, softAssignments: [], centroids: [] });
  });

  it("puts a single embedding in its own cluster with certainty", async () => {
    const result = await runClustering((service) =>
      service.clusterSoft([{ id: "single", vector: [1, 0, 0, 0] }], { maxClusters: 3 }),
    );

    expect(result).toMatchObject({
      numClusters: 1,
      softAssignments: [{ chunkId: "single", clusterId: 0, probability: 1 }],
      centroids: [{ clusterId: 0, vector: [1, 0, 0, 0] }],
    });
  });
});

describe("ClusteringService - Mini-Batch K-Means", () => {
  it("clusters a large dataset", async () => {
    const dims = 128;
    const embeddings = generateTestEmbeddings(200, dims, {
      numClusters: 5,
      spacing: 25,
      seed: 7,
    });

    const result = await runClustering((service) =>
      service.clusterMiniBatch(embeddings, {
        k: 5,
        batchSize: 100,
        maxIterations: 50,
        seed: 7,
      }),
    );

    expect(result.clusters).toHaveLength(5);
    expect(result.assignments).toHaveLength(1000);
    // Mini-batch can occasionally leave a cluster empty.
    expect(result.clusters.filter((c) => c.size > 0).length).toBeGreaterThanOrEqual(3);
    for (const cluster of result.clusters) {
      expect(cluster.centroid).toHaveLength(dims);
    }
  });

  it("produces cluster sizes similar to full k-means", async () => {
    const embeddings = generateTestEmbeddings(50, 8);

    const fullResult = await runClustering((service) =>
      service.cluster(embeddings, { k: 3, seed: 123 }),
    );
    const miniBatchResult = await runClustering((service) =>
      service.clusterMiniBatch(embeddings, { k: 3, batchSize: 10, seed: 123 }),
    );

    const fullSizes = fullResult.clusters.map((c) => c.size).sort();
    const miniBatchSizes = miniBatchResult.clusters.map((c) => c.size).sort();
    expect(miniBatchSizes).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const diff = Math.abs(fullSizes[i] - miniBatchSizes[i]);
      expect(diff / Math.max(fullSizes[i], miniBatchSizes[i])).toBeLessThan(0.3);
    }
  });

  it("handles a batch size larger than the dataset", async () => {
    const result = await runClustering((service) =>
      service.clusterMiniBatch(generateTestEmbeddings(5, 4), { k: 2, batchSize: 100 }),
    );

    expect(result.clusters).toHaveLength(2);
    expect(result.assignments).toHaveLength(15);
  });
});

describe("ClusteringService - Error Handling", () => {
  it("fails soft clustering for mismatched dimensions", async () => {
    const error = await clusteringFailure((service) =>
      service.clusterSoft(
        [
          { id: "a", vector: [1, 2, 3] },
          { id: "b", vector: [1, 2] },
        ],
        { maxClusters: 2 },
      ),
    );

    expect(error).toBeInstanceOf(ClusteringError);
    expect(error.reason).toContain("Dimension mismatch: vector 1 has 2 dims, expected 3");
  });

  it.each(["cluster", "clusterMiniBatch"] as const)(
    "%s fails when k exceeds the number of embeddings",
    async (method) => {
      const error = await clusteringFailure((service) =>
        service[method]([{ id: "1", vector: [1, 0] }], { k: 5 }),
      );

      expect(error).toBeInstanceOf(ClusteringError);
      expect(error.reason).toContain("k cannot exceed number of vectors");
    },
  );
});
