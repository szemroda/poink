import { afterEach, describe, expect, it, vi } from "vitest";
import { Data, Effect } from "effect";
import {
  processInBatches,
  createEmbeddingProcessor,
  getAdaptiveBatchSize,
  DEFAULT_QUEUE_CONFIG,
  type BatchProgress,
  type EmbeddingQueueConfig,
} from "./EmbeddingQueue.js";

class TestProcessError extends Data.TaggedError("TestProcessError")<{
  readonly message: string;
}> {}

/** Sequential, delay-free config so batch boundaries are observable. */
function testConfig(overrides: Partial<EmbeddingQueueConfig> = {}): EmbeddingQueueConfig {
  return {
    batchSize: 2,
    concurrency: 1,
    batchDelayMs: 0,
    checkpointAfterBatch: true,
    adaptiveBatchSize: false,
    ...overrides,
  };
}

/** Makes the heap look `heapUsedRatio` full to getAdaptiveBatchSize. */
function mockHeapUsage(heapUsedRatio: number): void {
  vi.spyOn(process, "memoryUsage").mockReturnValue({
    rss: 0,
    heapTotal: 1000,
    heapUsed: heapUsedRatio * 1000,
    external: 0,
    arrayBuffers: 0,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processInBatches", () => {
  it("processes items in order, checkpointing after each batch", async () => {
    const events: Array<number | "checkpoint"> = [];

    const result = await Effect.runPromise(
      processInBatches(
        [1, 2, 3, 4, 5, 6, 7],
        (n) => Effect.sync(() => { events.push(n); return n * 2; }),
        testConfig({ batchSize: 3 }),
        () => Effect.sync(() => { events.push("checkpoint"); }),
      ),
    );

    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(events).toEqual([1, 2, 3, "checkpoint", 4, 5, 6, "checkpoint", 7, "checkpoint"]);
  });

  it("skips afterBatch when checkpointAfterBatch is false", async () => {
    const afterBatch = vi.fn(() => Effect.void);

    await Effect.runPromise(
      processInBatches(
        [1, 2, 3, 4],
        Effect.succeed,
        testConfig({ checkpointAfterBatch: false }),
        afterBatch,
      ),
    );

    expect(afterBatch).not.toHaveBeenCalled();
  });

  it("reports progress after each batch", async () => {
    const progressReports: BatchProgress[] = [];

    await Effect.runPromise(
      processInBatches(
        [1, 2, 3, 4, 5, 6],
        Effect.succeed,
        testConfig(),
        undefined,
        (progress) => progressReports.push({ ...progress }),
      ),
    );

    expect(progressReports).toEqual([
      { batch: 1, totalBatches: 3, processed: 2, total: 6, percent: 33 },
      { batch: 2, totalBatches: 3, processed: 4, total: 6, percent: 67 },
      { batch: 3, totalBatches: 3, processed: 6, total: 6, percent: 100 },
    ]);
  });

  it("returns nothing for empty input without running hooks", async () => {
    const afterBatch = vi.fn(() => Effect.void);
    const onProgress = vi.fn();

    const result = await Effect.runPromise(
      processInBatches([], Effect.succeed, DEFAULT_QUEUE_CONFIG, afterBatch, onProgress),
    );

    expect(result).toEqual([]);
    expect(afterBatch).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("stops at the first failing item", async () => {
    const processed: number[] = [];

    const error = await Effect.runPromise(
      processInBatches(
        [1, 2, 3, 4],
        (n) => {
          processed.push(n);
          return n === 2 ? Effect.fail(new TestProcessError({ message: "boom" })) : Effect.succeed(n);
        },
        testConfig(),
      ).pipe(Effect.flip),
    );

    expect(error).toEqual(new TestProcessError({ message: "boom" }));
    expect(processed).toEqual([1, 2]);
  });

  it("bounds concurrency within a batch", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const process = (n: number) =>
      Effect.gen(function* () {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        yield* Effect.sleep("1 millis");
        currentConcurrent--;
        return n;
      });

    await Effect.runPromise(
      processInBatches([1, 2, 3, 4, 5, 6], process, testConfig({ batchSize: 6, concurrency: 3 })),
    );

    expect(maxConcurrent).toBe(3);
  });
});

describe("getAdaptiveBatchSize", () => {
  it.each([
    [0.4, 40],
    [0.6, 30],
    [0.8, 20],
    [0.9, 10],
  ])("scales a batch of 40 at heap usage %d to %d", (ratio, expected) => {
    mockHeapUsage(ratio);
    expect(getAdaptiveBatchSize(40)).toBe(expected);
  });

  it("does not shrink batches below 10 under pressure", () => {
    mockHeapUsage(0.9);
    expect(getAdaptiveBatchSize(20)).toBe(10);
  });
});

describe("createEmbeddingProcessor", () => {
  it("embeds texts in batches with checkpoints and progress", async () => {
    const checkpoint = vi.fn(() => Effect.void);
    const progress: number[] = [];
    const processor = createEmbeddingProcessor(
      (text: string) => Effect.succeed([text.length]),
      checkpoint,
      { batchSize: 2, batchDelayMs: 0, adaptiveBatchSize: false },
    );

    const result = await Effect.runPromise(
      processor.embedBatch(["a", "bb", "ccc"], (p) => progress.push(p.percent)),
    );

    expect(result).toEqual([[1], [2], [3]]);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([67, 100]);
  });

  it("shrinks the batch size under memory pressure when adaptive", async () => {
    mockHeapUsage(0.9);
    const checkpoint = vi.fn(() => Effect.void);
    const processor = createEmbeddingProcessor(
      () => Effect.succeed([1]),
      checkpoint,
      { batchSize: 40, batchDelayMs: 0 },
    );

    await Effect.runPromise(processor.embedBatch(Array.from({ length: 40 }, () => "text")));

    expect(checkpoint).toHaveBeenCalledTimes(4);
  });

  it("merges config overrides with the defaults", () => {
    const processor = createEmbeddingProcessor(
      () => Effect.succeed([1]),
      () => Effect.void,
      { batchSize: 100, concurrency: 10 },
    );

    expect(processor.getConfig()).toEqual({
      ...DEFAULT_QUEUE_CONFIG,
      batchSize: 100,
      concurrency: 10,
    });
  });
});
