import { Effect } from "effect";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import {
  CLIError,
  runCommandWithContext,
  type CommandBodyOutput,
  type GlobalCLIOptions,
} from "../runner.js";

interface ReindexCommandOptions extends Record<string, unknown> {
  clean?: boolean;
  doc?: string;
}

interface ReindexSummary {
  total: number;
  succeeded: number;
  failed: number;
  totalChunks: number;
  totalEmbeddings: number;
}

function createReindexOutput(
  summary: ReindexSummary,
  cleanFirst: boolean,
  docId: string | undefined,
): CommandBodyOutput {
  return {
    resultPayload: {
      ...summary,
      cleanFirst,
      docId: docId ?? null,
    },
    agentResult: {
      _tag: "reindex",
      count: summary.succeeded,
      errors: summary.failed,
    },
  };
}

export function runReindexCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: ReindexCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library }) =>
    Effect.gen(function* () {
      const cleanFirst = options.clean === true;
      const singleDocId = options.doc;

      yield* Console.log("Re-indexing embeddings...\n");

      const embedProvider = yield* EmbeddingProvider;
      yield* Console.log(`Provider: ${embedProvider.provider}`);

      const healthResult = yield* Effect.either(embedProvider.checkHealth());
      if (healthResult._tag === "Left") {
        yield* Console.error(`Embedding provider not ready: ${healthResult.left}`);
        return yield* Effect.fail(
          new CLIError("PROVIDER_NOT_READY", "Embedding provider not ready", {
            reason: String(healthResult.left),
            provider: embedProvider.provider,
          }),
        );
      }

      const docs = singleDocId
        ? yield* library.get(singleDocId).pipe(
            Effect.map((doc) => (doc ? [doc] : [])),
          )
        : yield* library.list();

      if (docs.length === 0) {
        yield* Console.log("No documents to reindex");
        return createReindexOutput(
          {
            total: 0,
            succeeded: 0,
            failed: 0,
            totalChunks: 0,
            totalEmbeddings: 0,
          },
          cleanFirst,
          singleDocId,
        );
      }

      yield* Console.log(`Documents to reindex: ${docs.length}\n`);

      if (cleanFirst) {
        yield* Console.log("Cleaning existing embeddings...");
        yield* library.repair();
        yield* Console.log("OK Cleaned\n");
      }

      let succeeded = 0;
      let failed = 0;
      let totalChunks = 0;
      let totalEmbeddings = 0;

      for (const [index, doc] of docs.entries()) {
        yield* Console.log(`[${index + 1}/${docs.length}] ${doc.title}`);

        const result = yield* Effect.either(library.reindexEmbeddings(doc.id));
        if (result._tag === "Right") {
          succeeded++;
          totalChunks += result.right.chunks;
          totalEmbeddings += result.right.embeddings;
          yield* Console.log(
            `  OK Reindexed ${result.right.embeddings}/${result.right.chunks} embeddings`,
          );
          continue;
        }

        failed++;
        yield* Console.error(`  FAIL Failed: ${String(result.left)}`);
      }

      yield* Console.log(`\nOK Reindexed ${succeeded} documents`);
      if (failed > 0) {
        yield* Console.log(`WARN ${failed} documents failed`);
      }

      return createReindexOutput(
        {
          total: docs.length,
          succeeded,
          failed,
          totalChunks,
          totalEmbeddings,
        },
        cleanFirst,
        singleDocId,
      );
    }),
    options);
}
