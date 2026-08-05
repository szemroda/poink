import { describe, it, expect } from "vitest";
import {
  mapClusterToConcept,
  type ClusterInput,
  type ConceptInput,
  type MapOptions,
} from "./ClusterConceptMapper.js";

function mapCluster(
  cluster: ClusterInput,
  concepts: ConceptInput[],
  options: MapOptions
) {
  return mapClusterToConcept(cluster, concepts, options);
}

describe("mapClusterToConcept", () => {
  it("should map cluster to existing concept when similarity is high", () => {
    const cluster = {
      id: 1,
      summary: "React hooks and state management",
      centroid: [0.1, 0.2, 0.3],
    };

    const concepts = [
      {
        id: "programming/react-hooks",
        label: "React Hooks",
        embedding: [0.1, 0.2, 0.3],
      },
      { id: "programming/vue", label: "Vue.js", embedding: [0.9, 0.8, 0.7] },
    ];

    const result = mapCluster(cluster, concepts, { threshold: 0.8 });

    expect(result.matched).toBe(true);
    expect(result.conceptId).toBe("programming/react-hooks");
  });

  it("should suggest new concept when no match found", () => {
    const cluster = {
      id: 2,
      summary: "Quantum computing algorithms",
      centroid: [1.0, 0.0, 0.0],
    };

    const concepts = [
      { id: "programming/react", label: "React", embedding: [0.0, 1.0, 0.0] },
    ];

    const result = mapCluster(cluster, concepts, { threshold: 0.8 });

    expect(result.matched).toBe(false);
    expect(result.suggestedLabel).toBe("Quantum computing algorithms");
  });

  it("should include matches exactly at the threshold", () => {
    const result = mapCluster(
      {
        id: 3,
        summary: "Threshold match",
        centroid: [1, 0],
      },
      [
        {
          id: "threshold-match",
          label: "Threshold Match",
          embedding: [0.8, 0.6],
        },
      ],
      { threshold: 0.8 }
    );

    expect(result).toMatchObject({
      matched: true,
      conceptId: "threshold-match",
      confidence: 0.8,
    });
  });

  it("should keep the first concept when similarities are equal", () => {
    const result = mapCluster(
      {
        id: 4,
        summary: "Equal matches",
        centroid: [1, 0],
      },
      [
        { id: "first", label: "First", embedding: [1, 0] },
        { id: "second", label: "Second", embedding: [1, 0] },
      ],
      { threshold: 0.8 }
    );

    expect(result.conceptId).toBe("first");
  });

  it("should truncate suggested labels from the first sentence", () => {
    const firstSentence = "A".repeat(60);
    const result = mapCluster(
      {
        id: 5,
        summary: `${firstSentence}. Ignored sentence`,
        centroid: [1, 0],
      },
      [],
      { threshold: 0.8 }
    );

    expect(result.suggestedLabel).toBe("A".repeat(50));
  });
});
