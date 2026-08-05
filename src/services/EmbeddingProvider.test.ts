import { afterEach, describe, expect, test, vi } from "vitest";
import { Effect } from "effect";
import { Config } from "../types.js";
import {
  EmbeddingProvider,
  makeEmbeddingProvider,
} from "./EmbeddingProvider.js";

vi.mock("ai", () => ({
  embed: vi.fn(),
  embedMany: vi.fn(),
}));

vi.mock("./AIProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./AIProvider.js")>();
  return {
    ...actual,
    getConfiguredEmbeddingModel: vi.fn(),
  };
});

const { embed } = await import("ai");
const { getConfiguredEmbeddingModel } = await import("./AIProvider.js");
const mockedEmbed = vi.mocked(embed);
const mockedGetConfiguredEmbeddingModel = vi.mocked(
  getConfiguredEmbeddingModel,
);

function resolvedModel() {
  return {
    provider: "openai" as const,
    modelId: "text-embedding-test",
    model: {} as never,
  };
}

function runWithProvider<A, E>(
  effect: Effect.Effect<A, E, EmbeddingProvider>,
) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(makeEmbeddingProvider(Config.Default))),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("EmbeddingProvider", () => {
  test("maps model resolution rejection into the typed provider channel", async () => {
    mockedGetConfiguredEmbeddingModel.mockRejectedValueOnce(
      new Error("credentials unavailable"),
    );

    const result = await runWithProvider(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProvider;
        return yield* Effect.either(provider.embed("query"));
      }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("OllamaError");
      expect(result.left.reason).toContain("model resolution failed");
      expect(result.left.reason).toContain("credentials unavailable");
    }
  });

  test("resolves the configured model once across concurrent requests", async () => {
    mockedGetConfiguredEmbeddingModel.mockResolvedValue(resolvedModel());
    mockedEmbed.mockResolvedValue({
      embedding: [0.1, 0.2],
    } as never);

    const result = await runWithProvider(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProvider;
        return yield* Effect.all(
          [provider.embed("one"), provider.embed("two")],
          { concurrency: "unbounded" },
        );
      }),
    );

    expect(result).toEqual([
      [0.1, 0.2],
      [0.1, 0.2],
    ]);
    expect(mockedGetConfiguredEmbeddingModel).toHaveBeenCalledTimes(1);
    expect(mockedEmbed).toHaveBeenCalledTimes(2);
    for (const [request] of mockedEmbed.mock.calls) {
      expect(request.abortSignal).toBeInstanceOf(AbortSignal);
      expect(request.maxRetries).toBe(0);
    }
  });

  test("establishes one dimension atomically for concurrent requests", async () => {
    mockedGetConfiguredEmbeddingModel.mockResolvedValue(resolvedModel());
    mockedEmbed.mockImplementation(async ({ value }) => {
      const embedding = value === "short" ? [0.1, 0.2] : [0.1, 0.2, 0.3];
      return { embedding } as never;
    });

    const results = await runWithProvider(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProvider;
        return yield* Effect.all(
          [
            Effect.either(provider.embed("short")),
            Effect.either(provider.embed("long")),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );

    expect(results.filter((result) => result._tag === "Right")).toHaveLength(1);
    const failure = results.find((result) => result._tag === "Left");
    expect(failure?._tag).toBe("Left");
    if (failure?._tag === "Left") {
      expect(failure.left.reason).toContain("expected");
    }
  });
});
