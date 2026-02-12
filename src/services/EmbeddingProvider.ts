/**
 * Unified Embedding Provider - Routes to Ollama, Gateway, or OpenAI based on config
 */
import { Effect, Context, Layer } from "effect";
import { loadConfig, OllamaError, GatewayError, OpenAIError } from "../types.js";
import { Ollama, OllamaLive } from "./Ollama.js";
import { Gateway, GatewayLive } from "./Gateway.js";
import { OpenAIEmbedding, OpenAIEmbeddingLive } from "./OpenAIEmbedding.js";

// ============================================================================
// Service Definition
// ============================================================================

// Union error type
export type EmbeddingError = OllamaError | GatewayError | OpenAIError;

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

/**
 * Agent workflows tend to call `search` repeatedly with the same query within a
 * single session (especially via MCP). Cache query embeddings in-process to
 * avoid repeated embed calls.
 *
 * Notes:
 * - This only wraps `embed()` (single text) and intentionally does NOT cache
 *   `embedBatch()` (chunk embeddings would explode memory).
 * - Cache is per-process (MCP session), not persisted.
 */
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
      // Refresh recency.
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

// ============================================================================
// Implementation
// ============================================================================

/**
 * Live implementation that routes based on config.embedding.provider
 */
export const EmbeddingProviderLive = Layer.effect(
  EmbeddingProvider,
  Effect.gen(function* () {
    const config = loadConfig();
    const provider = config.embedding.provider;
    const model = config.embedding.model;
    const queryCacheSize = readQueryEmbedCacheSize();
    const queryEmbedCache = makeLruCache<number[]>(queryCacheSize);

    const wrapQueryCache = <E>(
      embed: (text: string) => Effect.Effect<number[], E>,
      label: string,
    ) => {
      if (queryCacheSize <= 0) return embed;
      return (text: string) =>
        Effect.gen(function* () {
          const key = `${label}:${model}:${text}`;
          const cached = queryEmbedCache.get(key);
          if (cached) return cached;
          const embedding = yield* embed(text);
          queryEmbedCache.set(key, embedding);
          return embedding;
        });
    };

    if (provider === "gateway") {
      // Use Gateway
      const gateway = yield* Gateway;
      return {
        embed: wrapQueryCache(gateway.embed, "gateway"),
        embedBatch: gateway.embedBatch,
        checkHealth: gateway.checkHealth,
        provider: "gateway" as const,
      };
    } else if (provider === "openai") {
      // Use OpenAI
      const openai = yield* OpenAIEmbedding;
      return {
        embed: wrapQueryCache(openai.embed, "openai"),
        embedBatch: openai.embedBatch,
        checkHealth: openai.checkHealth,
        provider: "openai" as const,
      };
    } else {
      // Default to Ollama
      const ollama = yield* Ollama;
      return {
        embed: wrapQueryCache(ollama.embed, "ollama"),
        embedBatch: ollama.embedBatch,
        checkHealth: ollama.checkHealth,
        provider: "ollama" as const,
      };
    }
  }),
);

/**
 * Full layer with dependencies - use this in app composition.
 * Only constructs the provider layer that's actually configured.
 */
export const EmbeddingProviderFullLive = (() => {
  const config = loadConfig();
  const gatewayStub = Layer.succeed(Gateway, {
    embed: () =>
      Effect.fail(new GatewayError({ reason: "Gateway not configured" })),
    embedBatch: () =>
      Effect.fail(new GatewayError({ reason: "Gateway not configured" })),
    checkHealth: () =>
      Effect.fail(new GatewayError({ reason: "Gateway not configured" })),
  });

  const openAIStub = Layer.succeed(OpenAIEmbedding, {
    embed: () =>
      Effect.fail(new OpenAIError({ reason: "OpenAI not configured" })),
    embedBatch: () =>
      Effect.fail(new OpenAIError({ reason: "OpenAI not configured" })),
    checkHealth: () =>
      Effect.fail(new OpenAIError({ reason: "OpenAI not configured" })),
  });

  const deps =
    config.embedding.provider === "gateway"
      ? Layer.merge(Layer.merge(OllamaLive, GatewayLive), openAIStub)
      : config.embedding.provider === "openai"
        ? Layer.merge(Layer.merge(OllamaLive, gatewayStub), OpenAIEmbeddingLive)
        : Layer.merge(Layer.merge(OllamaLive, gatewayStub), openAIStub);
  return Layer.provide(EmbeddingProviderLive, deps);
})();
