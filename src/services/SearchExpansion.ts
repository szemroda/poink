import { Effect } from "effect";
import { DocumentSearchResult, type SearchOptions } from "../types.js";
import type { SearchRepositoryService } from "./StorageRepositories.js";

/** Context budget for result previews when no expansion was requested. */
const PREVIEW_EXPAND_CHARS = 500;

/**
 * Ranks results, keeps the top `limit`, and attaches surrounding chunk text to
 * each hit. Shared by semantic and full-text search. Hits whose chunk no
 * longer exists keep their own content.
 */
export function expandSearchResults(
  results: readonly DocumentSearchResult[],
  { limit, expandChars }: SearchOptions,
  search: SearchRepositoryService,
) {
  const maxChars = expandChars > 0 ? expandChars : PREVIEW_EXPAND_CHARS;
  return Effect.forEach(
    [...results].sort((a, b) => b.score - a.score).slice(0, limit),
    (result) =>
      Effect.map(
        search.getExpandedContext(
          result.docId,
          result.page,
          result.chunkIndex,
          maxChars,
        ),
        (expandedContent) =>
          expandedContent === null
            ? result
            : new DocumentSearchResult({ ...result, expandedContent }),
      ),
    { concurrency: 8 },
  );
}
