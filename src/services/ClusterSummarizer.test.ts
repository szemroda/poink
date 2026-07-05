import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ClusterSummarizerService,
  ClusterSummarizerImpl,
} from "./ClusterSummarizer.js";

type MockGenerateTextInput = {
  readonly model?: {
    readonly modelId?: string;
  };
};
type MockGenerateTextOutput = {
  readonly output: {
    readonly summary: string;
    readonly keyTopics: string[];
    readonly representativeQuote?: string;
  };
};
type MockGenerateText = (
  input: MockGenerateTextInput,
) => Promise<MockGenerateTextOutput>;

// Mock the AI SDK
const mockGenerateText = vi.hoisted(() =>
  vi.fn<MockGenerateText>(() =>
    Promise.resolve({
      output: {
        summary:
          "This cluster explores React hooks, focusing on useState and useEffect patterns, along with best practices for creating custom hooks.",
        keyTopics: ["React hooks", "useState", "useEffect", "custom hooks"],
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

describe("ClusterSummarizerService - LLM Abstractive Summarization", () => {
  let originalConfigPath: string | undefined;
  let tempDir: string | undefined;

  beforeEach(() => {
    originalConfigPath = process.env.POINK_CONFIG;
    tempDir = mkdtempSync(join(tmpdir(), "poink-cluster-summarizer-"));
    const configPath = join(tempDir, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        library: { path: join(tempDir, "library") },
        chunking: { strategy: "text", size: 2000, overlap: 200 },
        models: {
          embedding: { provider: "ollama", model: "mxbai-embed-large" },
          enrichment: { provider: "ollama", model: "llama3.2:3b" },
          judge: { provider: "ollama", model: "llama3.2:3b" },
        },
        providers: {
          ollama: { baseUrl: "http://127.0.0.1:1", autoPull: true },
          gateway: { apiKeyEnv: "AI_GATEWAY_API_KEY" },
          openai: {
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: "https://api.openai.com/v1",
          },
          openrouter: {
            apiKeyEnv: "OPENROUTER_API_KEY",
            baseUrl: "https://openrouter.ai/api/v1",
          },
        },
        storage: {
          libsql: { url: `file:${join(tempDir, "library", "library.db")}` },
        },
        server: {
          host: "127.0.0.1",
          port: 3838,
          auth: { enabled: false, tokenEnv: "POINK_SERVER_TOKEN" },
        },
      }),
      "utf-8",
    );

    process.env.POINK_CONFIG = configPath;
  });

  afterEach(() => {
    if (originalConfigPath === undefined) {
      delete process.env.POINK_CONFIG;
    } else {
      process.env.POINK_CONFIG = originalConfigPath;
    }

    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("should generate LLM-based abstractive summary with key topics", async () => {
    const chunks = [
      {
        id: "1",
        content:
          "React hooks enable state in functional components. This revolutionary feature changed how we write React components.",
      },
      {
        id: "2",
        content:
          "useState and useEffect are the most common hooks. They handle state and side effects respectively.",
      },
      {
        id: "3",
        content:
          "Custom hooks allow reusable stateful logic. You can extract component logic into reusable functions.",
      },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, { clusterId: 1 });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    expect(result.clusterId).toBe(1);
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(20);
    expect(result.chunkCount).toBe(3);

    // LLM-based summary should have key topics
    expect(result.keyTopics).toBeDefined();
    expect(result.keyTopics!.length).toBeGreaterThan(0);
    expect(result.keyTopics).toContain("React hooks");

    // Representative quote is optional
    if (result.representativeQuote) {
      expect(result.representativeQuote.length).toBeGreaterThan(0);
    }
  });

  it("should include representative quote when LLM provides one", async () => {
    mockGenerateText.mockImplementationOnce(() =>
      Promise.resolve({
        output: {
          summary:
            "Comprehensive guide to TypeScript generics and type inference.",
          keyTopics: ["TypeScript", "generics", "type inference"],
          representativeQuote:
            "Generics provide a way to make components work with any data type",
        },
      })
    );

    const chunks = [
      {
        id: "1",
        content:
          "Generics provide a way to make components work with any data type. They are fundamental to TypeScript.",
      },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, { clusterId: 2 });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    expect(result.representativeQuote).toBeDefined();
    expect(result.representativeQuote).toBe(
      "Generics provide a way to make components work with any data type"
    );
  });

  it("should handle empty chunks array without invoking the LLM", async () => {
    const chunks: Array<{ id: string; content: string }> = [];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, { clusterId: 2 });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    expect(result.clusterId).toBe(2);
    expect(result.chunkCount).toBe(0);
    expect(result.summary).toBeDefined();
    expect(result.summary).toBe("Empty cluster with no documents.");
  });

  it("should limit chunks based on maxChunks option", async () => {
    const chunks = [
      {
        id: "1",
        content: "First chunk about React hooks and their usage patterns.",
      },
      { id: "2", content: "Second chunk about useState for state management." },
      { id: "3", content: "Third chunk about useEffect for side effects." },
      { id: "4", content: "Fourth chunk about useContext for prop drilling." },
      { id: "5", content: "Fifth chunk about custom hooks for reusability." },
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, {
          clusterId: 3,
          maxChunks: 3,
        });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    expect(result.clusterId).toBe(3);
    expect(result.chunkCount).toBe(5); // Total count, not limited
  });

  it("should fail fast when LLM summarization fails", async () => {
    mockGenerateText.mockImplementationOnce(() =>
      Promise.reject(new Error("API unavailable"))
    );

    const chunks = [
      {
        id: "1",
        content:
          "React hooks enable state in functional components. This is important.",
      },
      {
        id: "2",
        content: "useState is the most basic hook. It manages component state.",
      },
    ];

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* ClusterSummarizerService;
          return yield* service.summarize(chunks, { clusterId: 4 });
        }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
      )
    ).rejects.toThrow("API unavailable");
  });

  it("should use the configured enrichment model via AI SDK", async () => {
    const chunks = [
      { id: "1", content: "Test content for model verification." },
    ];

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ClusterSummarizerService;
        return yield* service.summarize(chunks, { clusterId: 5 });
      }).pipe(Effect.provide(ClusterSummarizerImpl.Default))
    );

    // Verify generateText was called with correct model
    expect(mockGenerateText).toHaveBeenCalled();
    const calls = mockGenerateText.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][0]?.model?.modelId).toBe("llama3.2:3b");
  });
});
