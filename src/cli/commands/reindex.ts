import { Effect } from "effect";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import {
  CLIError,
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

interface ReindexCommandOptions extends Record<string, unknown> {
  clean?: boolean;
  doc?: string;
}

export function runReindexCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: ReindexCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library }) =>
    Effect.gen(function* () {
      const opts = options;
      const cleanFirst = opts.clean === true;
      const singleDocId = opts.doc as string | undefined;

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
        return {
          resultPayload: {
            total: 0,
            succeeded: 0,
            failed: 0,
            totalChunks: 0,
            totalEmbeddings: 0,
            cleanFirst,
            docId: singleDocId ?? null,
          },
          agentResult: { _tag: "reindex" as const, count: 0, errors: 0 },
        };
      }

      yield* Console.log(`Documents to reindex: ${docs.length}\n`);

      if (cleanFirst) {
        yield* Console.log("Cleaning existing embeddings...");
        yield* library.repair();
        yield* Console.log("OK Cleaned\n");
      }

      let processed = 0;
      let errors = 0;
      let totalChunks = 0;
      let totalEmbeddings = 0;

      for (const doc of docs) {
        processed++;
        yield* Console.log(`[${processed}/${docs.length}] ${doc.title}`);

        try {
          const result = yield* library.reindexEmbeddings(doc.id);
          totalChunks += result.chunks;
          totalEmbeddings += result.embeddings;
          yield* Console.log(
            `  OK Reindexed ${result.embeddings}/${result.chunks} embeddings`,
          );
        } catch (error) {
          errors++;
          const msg = error instanceof Error ? error.message : String(error);
          yield* Console.error(`  FAIL Failed: ${msg}`);
        }
      }

      yield* Console.log(`\nOK Reindexed ${processed - errors} documents`);
      if (errors > 0) {
        yield* Console.log(`WARN ${errors} documents failed`);
      }

      return {
        resultPayload: {
          total: docs.length,
          succeeded: processed - errors,
          failed: errors,
          totalChunks,
          totalEmbeddings,
          cleanFirst,
          docId: singleDocId ?? null,
        },
        agentResult: { _tag: "reindex" as const, count: processed - errors, errors },
      };
    }),
    options);
}
