import { Effect } from "effect";
import {
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

type RepairCommandOptions = Record<string, unknown>;

export function runRepairCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: RepairCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library }) =>
    Effect.gen(function* () {
      yield* Console.log("Checking database integrity...\n");
      const result = yield* library.repair();
      const completedRepairs = [
        [result.orphanedChunks, "orphaned chunks"],
        [result.orphanedEmbeddings, "orphaned embeddings"],
        [result.zeroVectorEmbeddings, "zero-dimension embeddings"],
      ] as const;
      const output = {
        resultPayload: result,
        agentResult: {
          _tag: "repair" as const,
          orphanedChunks: result.orphanedChunks,
          orphanedEmbeddings: result.orphanedEmbeddings,
        },
      };

      if (completedRepairs.every(([count]) => count === 0)) {
        yield* Console.log("OK Database is healthy - no repairs needed");
        return output;
      }

      yield* Console.log("Repairs completed:");
      for (const [count, description] of completedRepairs) {
        if (count <= 0) continue;
        yield* Console.log(`  - Removed ${count} ${description}`);
      }
      yield* Console.log("\nOK Database repaired");

      return output;
    }),
    options);
}
