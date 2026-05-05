/**
 * Unified Embedding Provider - Routes to Ollama, Gateway, or OpenAI based on config
 */
import { embed, embedMany } from "ai";
import { Effect, Context, Layer } from "effect";
import { GatewayError, loadConfig, OllamaError, OpenAIError } from "../types.js";
import {
  getConfiguredEmbeddingModel,
  type ProviderError,
} from "./AIProvider.js";

// ============================================================================
// Service Definition
// ============================================================================

export type EmbeddingError = ProviderError;

export class EmbeddingProvider extends Context.Tag("EmbeddingProvider")<
  EmbeddingProvider,
  {
    readonly embed: (text: string) => Effect.Effect<number[], EmbeddingError>;
    readonly embedBatch: (
      texts: string[],
      concurrency?: number,
    ) => Effect.Effect<number[][], EmbeddingError>;
    readonly checkHealth: () => Effect.Effect<void, EmbeddingError>;
    readonly provider: "ollama" | "gateway" | "openai";
  }
>() {}

const DEFAULT_QUERY_EMBED_CACHE_SIZE = 256;

const readQueryEmbedCacheSize = (): number => {
  const raw = process.env.PDF_BRAIN_QUERY_EMBED_CACHE_SIZE;
  if (raw === undefined) return DEFAULT_QUERY_EMBED_CACHE_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_QUERY_EMBED_CACHE_SIZE;
  return Math.floor(n);
};

const makeLruCache = <V>(maxSize: number) => {
  const map = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const value = map.get(key);
      if (value === undefined) return undefined;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key: string, value: V): void {
      if (maxSize <= 0) return;
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size <= maxSize) return;
      const oldest = map.keys().next().value as string | undefined;
      if (oldest) map.delete(oldest);
    },
  };
};

function toEmbeddingError(provider: string, message: string): EmbeddingError {
  if (provider === "gateway") {
    return new GatewayError({ reason: message });
  }
  if (provider === "openai") {
    return new OpenAIError({ reason: message });
  }
  return new OllamaError({ reason: message });
}

function validateEmbedding(
  embedding: number[],
  expectedDimension: number | null,
  provider: string,
): Effect.Effect<{ embedding: number[]; expectedDimension: number }, EmbeddingError> {
  if (embedding.length === 0) {
    return Effect.fail(
      toEmbeddingError(provider, "Invalid embedding: dimension 0 (empty vector)"),
    );
  }

  const nextExpectedDimension = expectedDimension ?? embedding.length;
  if (embedding.length !== nextExpectedDimension) {
    return Effect.fail(
      toEmbeddingError(
        provider,
        `Invalid embedding: dimension ${embedding.length} (expected ${nextExpectedDimension})`,
      ),
    );
  }

  if (embedding.some((value) => !Number.isFinite(value))) {
    return Effect.fail(
      toEmbeddingError(
        provider,
        "Invalid embedding: contains non-finite values (NaN or Infinity)",
      ),
    );
  }

  return Effect.succeed({
    embedding,
    expectedDimension: nextExpectedDimension,
  });
}

/**
 * Live implementation that routes based on config.embedding.provider
 */
export const EmbeddingProviderLive = Layer.effect(
  EmbeddingProvider,
  Effect.gen(function* () {
    const config = loadConfig();
    const resolved = getConfiguredEmbeddingModel(config);
    const queryCacheSize = readQueryEmbedCacheSize();
    const queryEmbedCache = makeLruCache<number[]>(queryCacheSize);
    let expectedDimension: number | null = null;

    const runEmbed = (
      texts: string[],
      maxParallelCalls?: number,
    ): Effect.Effect<number[][], EmbeddingError> =>
      Effect.tryPromise({
        try: async () => {
          if (texts.length === 0) return [];

          if (texts.length === 1) {
            const result = await embed({
              model: resolved.model,
              value: texts[0],
              maxRetries: 3,
            });
            return [result.embedding];
          }

          const result = await embedMany({
            model: resolved.model,
            values: texts,
            maxRetries: 3,
            maxParallelCalls,
          });
          return result.embeddings;
        },
        catch: (error) =>
          toEmbeddingError(
            resolved.provider,
            `Embedding failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      }).pipe(
        Effect.flatMap((embeddings) =>
          Effect.gen(function* () {
            const validated: number[][] = [];
            for (const embedding of embeddings) {
              const result = yield* validateEmbedding(
                embedding,
                expectedDimension,
                resolved.provider,
              );
              expectedDimension = result.expectedDimension;
              validated.push(result.embedding);
            }
            return validated;
          }),
        ),
      );

    const wrapQueryCache = (
      embedSingle: (text: string) => Effect.Effect<number[], EmbeddingError>,
    ) => {
      if (queryCacheSize <= 0) return embedSingle;
      return (text: string) =>
        Effect.gen(function* () {
          const key = `${resolved.provider}:${resolved.modelId}:${text}`;
          const cached = queryEmbedCache.get(key);
          if (cached) return cached;
          const embedding = yield* embedSingle(text);
          queryEmbedCache.set(key, embedding);
          return embedding;
        });
    };

    return {
      embed: wrapQueryCache((text: string) =>
        Effect.map(runEmbed([text]), (embeddings) => embeddings[0] as number[]),
      ),
      embedBatch: (texts: string[], concurrency = 10) => runEmbed(texts, concurrency),
      checkHealth: () => Effect.asVoid(runEmbed(["health check"])),
      provider: resolved.provider,
    };
  }),
);

/**
 * Full layer with dependencies - use this in app composition.
 */
export const EmbeddingProviderFullLive = EmbeddingProviderLive;
