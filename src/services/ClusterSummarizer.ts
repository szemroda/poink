import { Context, Effect, Layer } from "effect";
import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";
import { describeLanguageModelError, getConfiguredLanguageModel } from "./AIProvider.js";
import { loadConfig } from "../types.js";

/**
 * Summary metadata for a document cluster
 */
export interface ClusterSummary {
  readonly clusterId: number;
  readonly summary: string;
  readonly chunkCount: number;
  readonly keyTopics?: string[];
  readonly representativeQuote?: string;
}

export interface SummarizeOptions {
  readonly clusterId: number;
  readonly maxChunks?: number;
}

export interface ClusterSummarizerService {
  readonly summarize: (
    chunks: Array<{ id: string; content: string }>,
    options: SummarizeOptions
  ) => Effect.Effect<ClusterSummary, ClusterSummarizerError>;
}

export class ClusterSummarizerError {
  readonly _tag = "ClusterSummarizerError";
  constructor(readonly reason: string, readonly cause?: unknown) {}
}

export const ClusterSummarizerService =
  Context.GenericTag<ClusterSummarizerService>(
    "@services/ClusterSummarizerService"
  );

const SummarySchema = z.object({
  summary: z
    .string()
    .describe("2-4 sentence abstractive summary of the cluster's main themes"),
  keyTopics: z
    .array(z.string())
    .describe("3-6 key topics or themes covered in the cluster"),
  representativeQuote: z
    .string()
    .optional()
    .describe("Most representative or impactful quote from the chunks"),
});

async function generateSummary(
  chunks: Array<{ id: string; content: string }>,
  options: SummarizeOptions
): Promise<ClusterSummary> {
  if (chunks.length === 0) {
    return {
      clusterId: options.clusterId,
      summary: "Empty cluster with no documents.",
      chunkCount: 0,
    };
  }

  const config = loadConfig();
  const resolvedModel = getConfiguredLanguageModel(config, "summary");
  const maxChunks = options.maxChunks ?? chunks.length;
  const combinedContent = chunks
    .slice(0, maxChunks)
    .map((chunk, index) => `[Chunk ${index + 1}]\n${chunk.content}`)
    .join("\n\n");

  const { output } = await generateText({
    model: resolvedModel.model,
    output: Output.object({ schema: SummarySchema }),
    prompt: dedent`
      Analyze these document chunks from a knowledge library cluster and create an abstractive summary.

      ${combinedContent.slice(0, 6000)}

      Generate:
      - summary: A cohesive 2-4 sentence summary that captures the main themes and insights
      - keyTopics: 3-6 key topics or concepts covered across these chunks
      - representativeQuote: (optional) The most representative or impactful quote from the chunks

      Focus on synthesizing ideas across chunks, not just listing them.
    `,
  });

  return {
    clusterId: options.clusterId,
    summary: output.summary,
    chunkCount: chunks.length,
    keyTopics: output.keyTopics,
    representativeQuote: output.representativeQuote,
  };
}

export class ClusterSummarizerImpl {
  static Default = Layer.succeed(
    ClusterSummarizerService,
    ClusterSummarizerService.of({
      summarize: (chunks, options) =>
        Effect.tryPromise({
          try: () => generateSummary(chunks, options),
          catch: (error) =>
            new ClusterSummarizerError(
              describeLanguageModelError(error),
              error
            ),
        }),
    })
  );
}
