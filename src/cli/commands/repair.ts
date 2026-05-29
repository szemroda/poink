import { Effect } from "effect";
import {
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

interface RepairCommandOptions extends Record<string, unknown> {}

export function runRepairCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: RepairCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library }) =>
    Effect.gen(function* () {
      yield* Console.log("Checking database integrity...\n");
      const result = yield* library.repair();

      if (
        result.orphanedChunks === 0 &&
        result.orphanedEmbeddings === 0 &&
        result.zeroVectorEmbeddings === 0
      ) {
        yield* Console.log("OK Database is healthy - no repairs needed");
      } else {
        yield* Console.log("Repairs completed:");
        if (result.orphanedChunks > 0) {
          yield* Console.log(
            `  - Removed ${result.orphanedChunks} orphaned chunks`,
          );
        }
        if (result.orphanedEmbeddings > 0) {
          yield* Console.log(
            `  - Removed ${result.orphanedEmbeddings} orphaned embeddings`,
          );
        }
        if (result.zeroVectorEmbeddings > 0) {
          yield* Console.log(
            `  - Removed ${result.zeroVectorEmbeddings} zero-dimension embeddings`,
          );
        }
        yield* Console.log("\nOK Database repaired");
      }

      return {
        resultPayload: result,
        agentResult: {
          _tag: "repair" as const,
          orphanedChunks: result.orphanedChunks,
          orphanedEmbeddings: result.orphanedEmbeddings,
        },
      };
    }),
    options);
}
