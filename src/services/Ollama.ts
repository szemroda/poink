/**
 * Ollama Embedding Service
 */

import {
  Effect,
  Context,
  Layer,
  Schedule,
  Duration,
  Chunk,
  Stream,
} from "effect";
import { OllamaError, loadConfig } from "../types.js";
import { spawn } from "child_process";
import { getLogLevel } from "../logger.js";

// ============================================================================
// Service Definition
// ============================================================================

export class Ollama extends Context.Tag("Ollama")<
  Ollama,
  {
    readonly embed: (text: string) => Effect.Effect<number[], OllamaError>;
    readonly embedBatch: (
      texts: string[],
      concurrency?: number,
    ) => Effect.Effect<number[][], OllamaError>;
    readonly checkHealth: () => Effect.Effect<void, OllamaError>;
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

interface OllamaEmbeddingResponse {
  embedding: number[];
}

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

/**
 * Detected embedding dimension (set on first embedding call)
 * Different models have different dimensions:
 * - mxbai-embed-large: 1024
 * - nomic-embed-text: 768
 * - all-minilm: 384
 */
let detectedEmbeddingDimension: number | null = null;

export function normalizeOllamaHostUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed.slice(0, -"/api".length) : trimmed;
}

/**
 * Get the detected embedding dimension (for use by database schema)
 */
export function getEmbeddingDimension(): number | null {
  return detectedEmbeddingDimension;
}

/**
 * Validates embedding dimensions and values before database insert
 *
 * On first call, records the dimension for consistency checking.
 * Subsequent calls verify dimension matches the first.
 *
 * @param embedding - The embedding vector to validate
 * @returns Effect that fails with OllamaError if invalid
 */
function validateEmbedding(
  embedding: number[],
): Effect.Effect<number[], OllamaError> {
  return Effect.gen(function* () {
    if (embedding.length === 0) {
      return yield* new OllamaError({
        reason: "Invalid embedding: dimension 0 (empty vector)",
      });
    }

    // First embedding sets the expected dimension
    if (detectedEmbeddingDimension === null) {
      detectedEmbeddingDimension = embedding.length;
      yield* Effect.logDebug(
        `Ollama embedding dimension detected: ${detectedEmbeddingDimension}`,
      );
    } else if (embedding.length !== detectedEmbeddingDimension) {
      // Subsequent embeddings must match
      return yield* new OllamaError({
        reason: `Invalid embedding: dimension ${embedding.length} (expected ${detectedEmbeddingDimension})`,
      });
    }

    if (embedding.some((v) => !Number.isFinite(v))) {
      return yield* new OllamaError({
        reason:
          "Invalid embedding: contains non-finite values (NaN or Infinity)",
      });
    }

    return embedding;
  });
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isOllamaEmbeddingResponse(
  value: unknown,
): value is OllamaEmbeddingResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "embedding" in value &&
    isNumberArray(value.embedding)
  );
}

function isOllamaTagsResponse(value: unknown): value is OllamaTagsResponse {
  if (typeof value !== "object" || value === null || !("models" in value)) {
    return false;
  }
  const { models } = value;
  return (
    Array.isArray(models) &&
    models.every(
      (model) =>
        typeof model === "object" &&
        model !== null &&
        "name" in model &&
        typeof model.name === "string",
    )
  );
}

function readResponseText(
  response: Response,
): Effect.Effect<string, OllamaError> {
  return Effect.tryPromise({
    try: () => response.text(),
    catch: () => new OllamaError({ reason: "Failed to read error response" }),
  });
}

function parseJsonResponse<T>(
  response: Response,
  isExpected: (value: unknown) => value is T,
  invalidReason: string,
): Effect.Effect<T, OllamaError> {
  return Effect.tryPromise({
    try: async () => {
      const data: unknown = await response.json();
      if (!isExpected(data)) {
        throw new Error(invalidReason);
      }
      return data;
    },
    catch: () => new OllamaError({ reason: invalidReason }),
  });
}

function postOllamaEmbedding(
  ollamaHost: string,
  model: string,
  prompt: string,
): Effect.Effect<OllamaEmbeddingResponse, OllamaError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${ollamaHost}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt }),
        }),
      catch: (error) =>
        new OllamaError({ reason: `Connection failed: ${error}` }),
    });

    if (!response.ok) {
      const error = yield* readResponseText(response);
      return yield* new OllamaError({ reason: error });
    }

    return yield* parseJsonResponse(
      response,
      isOllamaEmbeddingResponse,
      "Invalid JSON response",
    );
  });
}

/**
 * Auto-install a model using `ollama pull`
 * @param model - Model name to install
 * @param host - Ollama host URL
 */
function autoInstallModel(
  model: string,
  host: string,
): Effect.Effect<void, OllamaError> {
  return Effect.gen(function* () {
    yield* Effect.logInfo(`Ollama: installing model ${model}...`);

    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const proc = spawn("ollama", ["pull", model], {
            // Never pollute stdout (agent protocol). Forward to stderr if enabled.
            stdio: ["ignore", "pipe", "pipe"],
          });

          // Forward streaming output to stderr only when debugging.
          const debug = getLogLevel() === "debug";
          if (debug) {
            proc.stdout?.on("data", (chunk) => {
              try {
                process.stderr.write(`[ollama:pull] ${chunk.toString()}`);
              } catch {}
            });
            proc.stderr?.on("data", (chunk) => {
              try {
                process.stderr.write(`[ollama:pull] ${chunk.toString()}`);
              } catch {}
            });
          }

          proc.on("close", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `ollama pull exited with code ${code}. Ensure Ollama is running and the model name is valid.`,
                ),
              );
            }
          });

          proc.on("error", (err) => {
            reject(
              new Error(
                `Failed to spawn ollama pull: ${err.message}. Ensure Ollama CLI is installed.`,
              ),
            );
          });
        }),
      catch: (e) =>
        new OllamaError({
          reason: `Auto-install failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
    });

    yield* Effect.logInfo("Ollama: model installed successfully");
  });
}

/**
 * Probe the embedding model to detect its dimension
 * Call this BEFORE creating database schema
 */
export function probeEmbeddingDimension(
  host: string,
  model: string,
): Effect.Effect<number, OllamaError> {
  return Effect.gen(function* () {
    const ollamaHost = normalizeOllamaHostUrl(host);
    const data = yield* postOllamaEmbedding(
      ollamaHost,
      model,
      "dimension probe",
    );
    const dimension = data.embedding?.length ?? 0;
    if (dimension === 0) {
      return yield* new OllamaError({ reason: "Probe returned empty embedding" });
    }

    // Cache the detected dimension
    detectedEmbeddingDimension = dimension;
    yield* Effect.logDebug(`Ollama embedding dimension probed: ${dimension}`);
    return dimension;
  });
}

export const OllamaLive = Layer.effect(
  Ollama,
  Effect.gen(function* () {
    const config = loadConfig();
    const ollamaHost = normalizeOllamaHostUrl(config.providers.ollama.baseUrl);

    const embedSingle = (text: string): Effect.Effect<number[], OllamaError> =>
      Effect.gen(function* () {
        const data = yield* postOllamaEmbedding(
          ollamaHost,
          config.models.embedding.model,
          text,
        );

        // Validate embedding before returning to prevent database corruption
        return yield* validateEmbedding(data.embedding);
      }).pipe(
        // Retry with exponential backoff on transient failures
        Effect.retry(
          Schedule.exponential(Duration.millis(100)).pipe(
            Schedule.compose(Schedule.recurs(3)),
          ),
        ),
      );

    return {
      embed: embedSingle,

      embedBatch: (texts: string[], concurrency = 5) =>
        Stream.fromIterable(texts).pipe(
          Stream.mapEffect(embedSingle, { concurrency }),
          Stream.runCollect,
          Effect.map(Chunk.toArray),
        ),

      checkHealth: () =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: () => fetch(`${ollamaHost}/api/tags`),
            catch: () =>
              new OllamaError({
                reason: `Cannot connect to Ollama at ${ollamaHost}`,
              }),
          });

          if (!response.ok) {
            return yield* new OllamaError({ reason: "Ollama not responding" });
          }

          const data = yield* parseJsonResponse(
            response,
            isOllamaTagsResponse,
            "Invalid response from Ollama",
          );

          const modelName = config.models.embedding.model;
          const hasModel = data.models.some(
            (m) => m.name === modelName || m.name.startsWith(`${modelName}:`),
          );

          if (!hasModel) {
            if (config.providers.ollama.autoPull) {
              // Auto-install the model
              yield* autoInstallModel(modelName, ollamaHost);
            } else {
              return yield* new OllamaError({
                reason: `Model ${modelName} not found. Run: ollama pull ${modelName}`,
              });
            }
          }
        }),
    };
  }),
);
