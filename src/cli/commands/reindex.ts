import { Effect } from "effect";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import {
  CLIError,
  runCommandWithLibraryContext,
  type CommandBodyOutput,
  type CommandExecutionContext,
  type GlobalCLIOptionsWithLibrary,
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

/** What a full-library rebuild replaced besides chunk vectors. */
interface RebuildSummary {
  embedding: { provider: string; model: string };
  dimensions: number;
  concepts: number;
}

function createReindexOutput(
  summary: ReindexSummary,
  cleanFirst: boolean,
  docId: string | undefined,
  rebuild: RebuildSummary | null,
): CommandBodyOutput {
  return {
    resultPayload: {
      ...summary,
      cleanFirst,
      docId: docId ?? null,
      rebuild,
    },
    agentResult: { _tag: "reindex" },
  };
}

/** Re-embeds one document with the configured model, which must be the library's model. */
function reindexDocument(
  { Console, library }: CommandExecutionContext,
  docId: string,
  cleanFirst: boolean,
) {
  return Effect.gen(function* () {
    const doc = yield* library.get(docId);
    if (!doc) {
      yield* Console.log("No documents to reindex");
      return createReindexOutput(
        { total: 0, succeeded: 0, failed: 0, totalChunks: 0, totalEmbeddings: 0 },
        cleanFirst,
        docId,
        null,
      );
    }

    yield* Console.log(doc.title);
    const result = yield* Effect.either(library.reindexEmbeddings(doc.id));
    if (result._tag === "Left") {
      yield* Console.error(`  FAIL Failed: ${String(result.left)}`);
      return createReindexOutput(
        { total: 1, succeeded: 0, failed: 1, totalChunks: 0, totalEmbeddings: 0 },
        cleanFirst,
        docId,
        null,
      );
    }

    const { chunks, embeddings } = result.right;
    yield* Console.log(`  OK Reindexed ${embeddings}/${chunks} embeddings`);
    return createReindexOutput(
      {
        total: 1,
        succeeded: 1,
        failed: 0,
        totalChunks: chunks,
        totalEmbeddings: embeddings,
      },
      cleanFirst,
      docId,
      null,
    );
  });
}

/** Rebuilds every vector with the configured model and records it as the library's model. */
function rebuildLibrary(
  { Console, library, globals }: CommandExecutionContext,
  cleanFirst: boolean,
) {
  return Effect.gen(function* () {
    const embedding = globals.config!.models.embedding;
    yield* Console.log(
      `Rebuilding every vector with ${embedding.provider}/${embedding.model}...\n`,
    );
    const rebuilt = yield* library.rebuildEmbeddings((doc, index, total) =>
      Console.log(`[${index + 1}/${total}] ${doc.title}`),
    );
    yield* Console.log(
      `\nOK Rebuilt ${rebuilt.chunks} chunk vector(s) across ${rebuilt.documents} document(s) and ${rebuilt.concepts} concept vector(s) (${rebuilt.dimensions} dimensions)`,
    );

    return createReindexOutput(
      {
        total: rebuilt.documents,
        succeeded: rebuilt.documents,
        failed: 0,
        totalChunks: rebuilt.chunks,
        totalEmbeddings: rebuilt.chunks,
      },
      cleanFirst,
      undefined,
      {
        embedding: { provider: embedding.provider, model: embedding.model },
        dimensions: rebuilt.dimensions,
        concepts: rebuilt.concepts,
      },
    );
  });
}

/**
 * `poink reindex` rebuilds every vector atomically with the configured
 * embedding model; this is how a library changes models. `--doc` re-embeds a
 * single document with the library's current model.
 */
export function runReindexCommand(
  args: string[],
  globals: GlobalCLIOptionsWithLibrary,
  options: ReindexCommandOptions = {},
) {
  return runCommandWithLibraryContext(args, globals, (context) =>
    Effect.gen(function* () {
      const { Console, library } = context;
      const cleanFirst = options.clean === true;

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

      if (cleanFirst) {
        yield* Console.log("Cleaning orphaned chunks and embeddings...");
        yield* library.repair();
        yield* Console.log("OK Cleaned\n");
      }

      return options.doc
        ? yield* reindexDocument(context, options.doc, cleanFirst)
        : yield* rebuildLibrary(context, cleanFirst);
    }),
  );
}
