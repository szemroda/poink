import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { Config, saveConfig } from "../types.js";
import {
  ClusterSummarizerService,
  ClusterSummarizerImpl,
} from "./ClusterSummarizer.js";

type MockGenerateTextInput = {
  readonly prompt: string;
  readonly model: { readonly modelId: string };
};
type MockGenerateTextOutput = {
  readonly output: {
    readonly summary: string;
    readonly keyTopics: string[];
    readonly representativeQuote?: string;
  };
};

const mockGenerateText = vi.hoisted(() =>
  vi.fn<(input: MockGenerateTextInput) => Promise<MockGenerateTextOutput>>(() =>
    Promise.resolve({
      output: {
        summary: "React hooks bring state to functional components.",
        keyTopics: ["React hooks", "useState"],
        representativeQuote: "React hooks enable state in functional components",
      },
    }),
  ),
);

vi.mock("ai", () => ({
  Output: {
    object: (spec: unknown) => spec,
  },
  generateText: mockGenerateText,
}));

function summarize(
  chunks: Array<{ id: string; content: string }>,
  options: { clusterId: number; maxChunks?: number },
) {
  return Effect.runPromise(
    Effect.flatMap(ClusterSummarizerService, (service) =>
      service.summarize(chunks, options),
    ).pipe(Effect.provide(ClusterSummarizerImpl.Default)),
  );
}

const chunks = [1, 2, 3, 4, 5].map((n) => ({
  id: String(n),
  content: `Chunk content number ${n}.`,
}));

beforeAll(() => {
  // testSetup points POINK_CONFIG at a per-file temp path.
  saveConfig(
    new Config({
      ...Config.Default,
      models: {
        ...Config.Default.models,
        enrichment: { provider: "ollama", model: "summary-model:1b" },
      },
    }),
  );
});

afterEach(() => {
  mockGenerateText.mockClear();
});

describe("ClusterSummarizerService", () => {
  it("summarizes chunks with the configured enrichment model", async () => {
    const result = await summarize(chunks.slice(0, 3), { clusterId: 1 });

    expect(result).toEqual({
      clusterId: 1,
      summary: "React hooks bring state to functional components.",
      chunkCount: 3,
      keyTopics: ["React hooks", "useState"],
      representativeQuote: "React hooks enable state in functional components",
    });
    expect(mockGenerateText).toHaveBeenCalledOnce();
    expect(mockGenerateText.mock.calls[0][0].model.modelId).toBe("summary-model:1b");
  });

  it("summarizes an empty cluster without invoking the LLM", async () => {
    expect(await summarize([], { clusterId: 2 })).toEqual({
      clusterId: 2,
      summary: "Empty cluster with no documents.",
      chunkCount: 0,
    });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("prompts with at most maxChunks chunks but counts all of them", async () => {
    const result = await summarize(chunks, { clusterId: 3, maxChunks: 3 });

    expect(result.chunkCount).toBe(5);
    const { prompt } = mockGenerateText.mock.calls[0][0];
    expect(prompt).toContain("Chunk content number 3.");
    expect(prompt).not.toContain("Chunk content number 4.");
  });

  it("fails when LLM summarization fails", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("API unavailable"));

    await expect(summarize(chunks, { clusterId: 4 })).rejects.toThrow(
      "API unavailable",
    );
  });
});
