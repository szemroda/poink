/**
 * Embedding batch settings shared by ingestion and reindexing.
 *
 * Embeddings are generated in small batches with bounded concurrency and a
 * short delay between batches, which keeps provider load and transient memory
 * bounded on large libraries.
 */

interface EmbeddingQueueConfig {
  /** Maximum embeddings per batch */
  batchSize: number;

  /** Concurrency for embedding calls within a batch */
  concurrency: number;

  /** Delay between batches (milliseconds), lets the event loop and GC breathe */
  batchDelayMs: number;
}

/**
 * Default configuration - conservative, tuned for stability over speed
 */
export const DEFAULT_QUEUE_CONFIG: EmbeddingQueueConfig = {
  batchSize: 20,
  concurrency: 3,
  batchDelayMs: 50,
};
