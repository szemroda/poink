import { describe, it, expect } from "vitest";
import { mapClusterToConcept } from "./ClusterConceptMapper.js";

describe("mapClusterToConcept", () => {
  it("maps a cluster to the most similar concept above the threshold", () => {
    const result = mapClusterToConcept(
      { id: 1, summary: "React hooks and state management", centroid: [0.1, 0.2, 0.3] },
      [
        { id: "programming/vue", label: "Vue.js", embedding: [0.9, 0.8, 0.7] },
        { id: "programming/react-hooks", label: "React Hooks", embedding: [0.1, 0.2, 0.3] },
      ],
      { threshold: 0.8 },
    );

    expect(result).toEqual({
      clusterId: 1,
      matched: true,
      conceptId: "programming/react-hooks",
      confidence: expect.closeTo(1),
    });
  });

  it("suggests a label from the summary when no concept matches", () => {
    const result = mapClusterToConcept(
      { id: 2, summary: "Quantum computing algorithms", centroid: [1, 0, 0] },
      [{ id: "programming/react", label: "React", embedding: [0, 1, 0] }],
      { threshold: 0.8 },
    );

    expect(result).toEqual({
      clusterId: 2,
      matched: false,
      suggestedLabel: "Quantum computing algorithms",
    });
  });

  it("includes matches exactly at the threshold", () => {
    const result = mapClusterToConcept(
      { id: 3, summary: "Threshold match", centroid: [1, 0] },
      [{ id: "threshold-match", label: "Threshold Match", embedding: [0.8, 0.6] }],
      { threshold: 0.8 },
    );

    expect(result).toMatchObject({
      matched: true,
      conceptId: "threshold-match",
      confidence: 0.8,
    });
  });

  it("keeps the first concept when similarities are equal", () => {
    const result = mapClusterToConcept(
      { id: 4, summary: "Equal matches", centroid: [1, 0] },
      [
        { id: "first", label: "First", embedding: [1, 0] },
        { id: "second", label: "Second", embedding: [1, 0] },
      ],
      { threshold: 0.8 },
    );

    expect(result.conceptId).toBe("first");
  });

  it("truncates suggested labels taken from the first sentence", () => {
    const result = mapClusterToConcept(
      { id: 5, summary: `${"A".repeat(60)}. Ignored sentence`, centroid: [1, 0] },
      [],
      { threshold: 0.8 },
    );

    expect(result.suggestedLabel).toBe("A".repeat(50));
  });
});
