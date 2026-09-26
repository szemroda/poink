import { Effect } from "effect";
import {
  AutoTagger,
  type EnrichmentResult,
} from "../services/AutoTagger.js";
import type { CliConsole } from "./commands/types.js";

/**
 * Links a newly committed document to its enrichment concepts and returns the
 * outcome. A failure is logged as a warning because the document itself was
 * stored successfully.
 */
export function assignEnrichmentConcepts(
  Console: CliConsole,
  docId: string,
  enrichment: EnrichmentResult | undefined,
  indent: string,
) {
  return Effect.gen(function* () {
    if (!enrichment) return undefined;

    const tagger = yield* AutoTagger;
    const result = yield* Effect.either(
      tagger.assignConcepts(docId, enrichment),
    );
    if (result._tag === "Right") return result.right;

    yield* Console.log(
      `${indent}WARN Document added, but concept assignment failed: ${result.left.message}`,
    );
    return undefined;
  });
}
