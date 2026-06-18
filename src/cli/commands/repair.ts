import { Effect } from "effect";
import {
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

type RepairCommandOptions = Record<string, unknown>;

type CompletedRepair = readonly [count: number, description: string];

function listCompletedRepairs(result: {
  orphanedChunks: number;
  orphanedEmbeddings: number;
  zeroVectorEmbeddings: number;
}): readonly CompletedRepair[] {
  return [
    [result.orphanedChunks, "orphaned chunks"],
    [result.orphanedEmbeddings, "orphaned embeddings"],
    [result.zeroVectorEmbeddings, "zero-dimension embeddings"],
  ];
}

export function runRepairCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: RepairCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library }) =>
    Effect.gen(function* () {
      yield* Console.log("Checking database integrity...\n");
      const result = yield* library.repair();
      const completedRepairs = listCompletedRepairs(result);
      const output = {
        resultPayload: result,
        agentResult: {
          _tag: "repair" as const,
          orphanedChunks: result.orphanedChunks,
          orphanedEmbeddings: result.orphanedEmbeddings,
        },
      };

      const repairsToReport = completedRepairs.filter(([count]) => count > 0);
      const hasRepairs = completedRepairs.some(([count]) => count !== 0);
      if (!hasRepairs) {
        yield* Console.log("OK Database is healthy - no repairs needed");
        return output;
      }

      yield* Console.log("Repairs completed:");
      for (const [count, description] of repairsToReport) {
        yield* Console.log(`  - Removed ${count} ${description}`);
      }
      yield* Console.log("\nOK Database repaired");

      return output;
    }),
    options);
}
