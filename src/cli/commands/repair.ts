import { Effect } from "effect";
import {
  runCommandWithLibraryContext,
  type GlobalCLIOptionsWithLibrary,
  type StoreCliLibrary,
} from "../runner.js";

type CompletedRepair = readonly [count: number, description: string];

function listCompletedRepairs(result: {
  orphanedChunks: number;
  orphanedEmbeddings: number;
}): readonly CompletedRepair[] {
  return [
    [result.orphanedChunks, "orphaned chunks"],
    [result.orphanedEmbeddings, "orphaned embeddings"],
  ];
}

export function runRepairCommand(
  args: string[],
  globals: GlobalCLIOptionsWithLibrary<StoreCliLibrary>,
) {
  return runCommandWithLibraryContext(args, globals, ({ Console, library }) =>
    Effect.gen(function* () {
      yield* Console.log("Checking database integrity...\n");
      const result = yield* library.repair();
      const completedRepairs = listCompletedRepairs(result);
      const output = {
        resultPayload: result,
        agentResult: { _tag: "repair" as const },
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
  );
}
