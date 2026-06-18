/**
 * HATEOAS-style hint engine for poink CLI.
 *
 * Pure function: CommandResult discriminated union in, string[] hints out.
 */

import type { NextAction } from "./protocol.js";

export type CommandResult =
  | {
      _tag: "search";
      query: string;
      results: { title: string; docId: string; chunkId?: string; score: number }[];
      concepts: { id: string; prefLabel: string }[];
      hadExpand: boolean;
      wasFts: boolean;
    }
  | {
      _tag: "searchPack";
      queries: string[];
      results: { title: string; docId: string; chunkId?: string; score: number }[];
    }
  | { _tag: "read"; title: string; id: string; tags: string[] }
  | {
      _tag: "list";
      count: number;
      tag?: string;
      firstDoc?: { title: string; id: string };
    }
  | {
      _tag: "stats";
      documents: number;
      chunks: number;
      embeddings: number;
    }
  | {
      _tag: "taxonomySearch";
      query: string;
      matches: { id: string; prefLabel: string }[];
    }
  | { _tag: "taxonomyList"; count: number }
  | { _tag: "taxonomyTree"; rootId?: string }
  | { _tag: "add"; title: string; id: string }
  | { _tag: "remove"; title: string }
  | { _tag: "noResults"; query: string; wasFts: boolean }
  | { _tag: "error"; command: string; message: string }
  | {
      _tag: "doctor";
      healthy: boolean;
      chunkerOutdated?: number;
      chunkerMissing?: number;
      chunkerMismatch?: number;
    }
  | { _tag: "config"; subcommand: string }
  | { _tag: "tag"; title: string; tags: string[] }
  | { _tag: "check"; reachable: boolean }
  | { _tag: "repair"; orphanedChunks: number; orphanedEmbeddings: number }
  | { _tag: "reindex"; count: number; errors: number }
  | {
      _tag: "rechunk";
      dryRun: boolean;
      planned: number;
      succeeded: number;
      failed: number;
      includeMissing?: boolean;
      skippedMissing?: number;
      plannedMissing?: number;
      plannedMismatch?: number;
      plannedVisuals?: number;
      visuals?: boolean;
    };

function shellAction(description: string, ...argv: string[]): NextAction {
  return { kind: "shell", argv, description };
}

type SearchResult = Extract<CommandResult, { _tag: "search" }>;
type NoResultsResult = Extract<CommandResult, { _tag: "noResults" }>;

function hasNoSearchMatches(result: SearchResult): boolean {
  return result.results.length === 0 && result.concepts.length === 0;
}

function generateNoResultHints(result: NoResultsResult): string[] {
  const alternativeSearch = result.wasFts
    ? `\`poink search "${result.query}"\` -- Try semantic vector search`
    : `\`poink search "${result.query}" --fts\` -- Try full-text keyword search`;

  return [
    alternativeSearch,
    `\`poink list\` -- Browse all documents`,
    `\`poink taxonomy search "${result.query}"\` -- Search taxonomy concepts`,
  ];
}

function generateSearchHints(result: SearchResult): string[] {
  if (hasNoSearchMatches(result)) {
    return generateNoResultHints({
      _tag: "noResults",
      query: result.query,
      wasFts: result.wasFts,
    });
  }

  const hints: string[] = [];
  const topResult = result.results[0];
  if (topResult) {
    hints.push(
      `\`poink read "${topResult.title}"\` -- Full metadata for top result`,
    );
    if (!result.hadExpand) {
      hints.push(
        `\`poink search "${result.query}" --expand 2000\` -- Get expanded context around matches`,
      );
    }
  }

  const topConcept = result.concepts[0];
  if (topConcept) {
    hints.push(
      `\`poink taxonomy tree "${topConcept.id}"\` -- Navigate concept hierarchy`,
    );
  }

  if (topResult && !result.wasFts) {
    hints.push(
      `\`poink search "${result.query}" --fts\` -- Try keyword matching instead`,
    );
  }
  return hints;
}

function generateNoResultActions(result: NoResultsResult): NextAction[] {
  const alternativeSearch = result.wasFts
    ? shellAction(
        "Try semantic vector search",
        "poink",
        "search",
        result.query,
      )
    : shellAction(
        "Try full-text keyword search",
        "poink",
        "search",
        result.query,
        "--fts",
      );

  return [
    alternativeSearch,
    shellAction("Browse all documents", "poink", "list"),
    shellAction(
      "Search taxonomy concepts",
      "poink",
      "taxonomy",
      "search",
      result.query,
    ),
  ];
}

function generateSearchActions(result: SearchResult): NextAction[] {
  if (hasNoSearchMatches(result)) {
    return generateNoResultActions({
      _tag: "noResults",
      query: result.query,
      wasFts: result.wasFts,
    });
  }

  const actions: NextAction[] = [];
  const topResult = result.results[0];
  if (topResult) {
    actions.push(
      shellAction(
        "Full metadata for top result",
        "poink",
        "read",
        topResult.docId,
      ),
    );

    if (topResult.chunkId) {
      actions.push(
        shellAction(
          "Fetch exact top chunk text",
          "poink",
          "chunk",
          "get",
          topResult.chunkId,
        ),
      );
    }

    if (!result.hadExpand) {
      actions.push(
        shellAction(
          "Get expanded context around matches",
          "poink",
          "search",
          result.query,
          "--expand",
          "2000",
        ),
      );
    }
  }

  const topConcept = result.concepts[0];
  if (topConcept) {
    actions.push(
      shellAction(
        "Navigate concept hierarchy",
        "poink",
        "taxonomy",
        "tree",
        topConcept.id,
      ),
    );
  }

  if (topResult && !result.wasFts) {
    actions.push(
      shellAction(
        "Try keyword matching instead",
        "poink",
        "search",
        result.query,
        "--fts",
      ),
    );
  }
  return actions;
}

/**
 * Generate contextual next-action hints from a command result.
 * Returns an array of copy-pasteable command strings with descriptions.
 */
export function generateHints(result: CommandResult): string[] {
  switch (result._tag) {
    case "search": {
      return generateSearchHints(result);
    }

    case "searchPack": {
      const hints: string[] = [];
      if (result.results.length > 0) {
        const top = result.results[0];
        hints.push(
          `\`poink read "${top.title}"\` -- Full metadata for top result`
        );
        if (top.chunkId) {
          hints.push(
            `\`poink chunk get "${top.chunkId}"\` -- Fetch exact top chunk text`
          );
        }
      }
      hints.push(
        `\`poink search "<query>"\` -- Drill into a single query`,
        `\`poink search-pack --with-content "${result.queries[0] ?? "query"}"\` -- Include chunk text in pack output`,
      );
      return hints;
    }

    case "noResults": {
      return generateNoResultHints(result);
    }

    case "read": {
      const hints: string[] = [];
      hints.push(
        `\`poink search "${result.title}" --expand 2000\` -- Search within this document's content`
      );
      if (result.tags.length > 0) {
        hints.push(
          `\`poink list --tag "${result.tags[0]}"\` -- Browse documents with same tag`
        );
      }
      hints.push(
        `\`poink taxonomy search "${result.title}"\` -- Find related concepts`
      );
      return hints;
    }

    case "list": {
      const hints: string[] = [];
      if (result.firstDoc) {
        hints.push(
          `\`poink read "${result.firstDoc.title}"\` -- View document details`
        );
      }
      hints.push(
        `\`poink search "<query>"\` -- Search across all documents`
      );
      if (!result.tag) {
        hints.push(
          `\`poink taxonomy list\` -- Browse concept categories`
        );
      }
      return hints;
    }

    case "stats": {
      const hints: string[] = [];
      hints.push(
        `\`poink search "<query>"\` -- Search across ${result.documents} documents`,
        `\`poink list\` -- Browse all documents`,
        `\`poink taxonomy list\` -- Browse concept taxonomy`,
        `\`poink doctor\` -- Run health check`
      );
      return hints;
    }

    case "taxonomySearch": {
      const hints: string[] = [];
      if (result.matches.length > 0) {
        const top = result.matches[0];
        hints.push(
          `\`poink taxonomy tree "${top.id}"\` -- Navigate hierarchy from "${top.prefLabel}"`
        );
        hints.push(
          `\`poink search "${top.prefLabel}"\` -- Find documents tagged with this concept`
        );
      } else {
        hints.push(
          `\`poink taxonomy list\` -- Browse all concepts`,
          `\`poink search "${result.query}"\` -- Search documents instead`
        );
      }
      return hints;
    }

    case "taxonomyList": {
      const hints: string[] = [];
      hints.push(
        `\`poink taxonomy tree\` -- Show hierarchy tree view`,
        `\`poink taxonomy search "<query>"\` -- Find specific concepts`,
        `\`poink search "<query>"\` -- Search documents by content`
      );
      return hints;
    }

    case "taxonomyTree": {
      const hints: string[] = [];
      hints.push(
        `\`poink taxonomy search "<query>"\` -- Find concepts by keyword`,
        `\`poink search "<query>"\` -- Search documents by content`
      );
      if (result.rootId) {
        hints.push(
          `\`poink taxonomy tree\` -- View full concept tree`
        );
      }
      return hints;
    }

    case "add": {
      return [
        `\`poink read "${result.title}"\` -- View document details`,
        `\`poink search "${result.title}" --expand 2000\` -- Search within this document`,
        `\`poink tag "${result.id}" "topic1,topic2"\` -- Add tags`,
      ];
    }

    case "remove": {
      return [
        `\`poink list\` -- Browse remaining documents`,
        `\`poink stats\` -- Check library statistics`,
      ];
    }

    case "tag": {
      return [
        `\`poink read "${result.title}"\` -- View updated document`,
        `\`poink list --tag "${result.tags[0]}"\` -- Browse documents with this tag`,
      ];
    }

    case "doctor": {
      const hints: string[] = [];
      if (!result.healthy) {
        hints.push(
          `\`poink doctor --fix\` -- Auto-repair detected issues`
        );
      }
      const missing = result.chunkerMissing ?? 0;
      const mismatch = result.chunkerMismatch ?? 0;

      if (mismatch > 0) {
        hints.push(
          `\`poink rechunk --dry-run\` -- Preview docs with stale chunker metadata`,
          `\`poink rechunk\` -- Apply rechunk (rebuild chunks + embeddings)`,
        );
      }

      if (missing > 0) {
        hints.push(
          `\`poink rechunk --dry-run --include-missing\` -- Preview docs missing chunker metadata (upgrade sweep)`,
          `\`poink rechunk --include-missing --max-docs 25\` -- Rechunk a small batch (expensive)`,
        );
      }
      hints.push(
        `\`poink stats\` -- Check library statistics`,
        `\`poink search "<query>"\` -- Search documents`
      );
      return hints;
    }

    case "config": {
      return [
        `\`poink config show\` -- View all settings`,
        `\`poink config set models.embedding.model <model>\` -- Change embedding model`,
        `\`poink stats\` -- Check library statistics`,
      ];
    }

    case "check": {
      const hints: string[] = [];
      if (result.reachable) {
        hints.push(
          `\`poink search "<query>"\` -- Search documents`,
          `\`poink stats\` -- Check library statistics`
        );
      } else {
        hints.push(
          `\`poink doctor\` -- Run full health check`,
          `\`poink config show\` -- Check configuration`
        );
      }
      return hints;
    }

    case "repair": {
      return [
        `\`poink doctor\` -- Run full health check`,
        `\`poink stats\` -- Check library statistics`,
      ];
    }

    case "rechunk": {
      const hints: string[] = [];
      if (result.dryRun) {
        if (result.includeMissing) {
          hints.push(
            `\`poink rechunk --include-missing --max-docs 25\` -- Rechunk a small batch (rebuild chunks + embeddings)`,
          );
        } else {
          hints.push(
            `\`poink rechunk\` -- Apply rechunk (rebuild chunks + embeddings)`,
          );
          if ((result.skippedMissing ?? 0) > 0) {
            hints.push(
              `\`poink rechunk --dry-run --include-missing\` -- Include missing-metadata docs in the plan`,
            );
          }
        }
      } else {
        hints.push(
          `\`poink stats\` -- Verify counts after rechunk`,
          `\`poink search "<query>"\` -- Sanity-check retrieval quality`,
        );
      }
      return hints;
    }

    case "reindex": {
      return [
        `\`poink stats\` -- Check updated statistics`,
        `\`poink search "<query>"\` -- Test search with new embeddings`,
      ];
    }

    case "error": {
      return [
        `\`poink doctor\` -- Run health check`,
        `\`poink check\` -- Verify embedding provider`,
        `\`poink --help\` -- View all commands`,
      ];
    }

    default: {
      const _exhaustive: never = result;
      return [];
    }
  }
}

/**
 * Structured follow-up actions for agent workflows.
 * These are equivalent to `generateHints`, but machine-friendly.
 */
export function generateNextActions(result: CommandResult): NextAction[] {
  switch (result._tag) {
    case "search": {
      return generateSearchActions(result);
    }

    case "searchPack": {
      const actions: NextAction[] = [];
      if (result.results.length > 0) {
        const top = result.results[0];
        actions.push(
          shellAction("Read top document metadata", "poink", "read", top.docId),
        );
        if (top.chunkId) {
          actions.push(
            shellAction(
              "Fetch exact top chunk text",
              "poink",
              "chunk",
              "get",
              top.chunkId,
            ),
          );
        }
      }
      actions.push(
        shellAction(
          "Drill into a single query",
          "poink",
          "search",
          "your query here",
        ),
      );
      return actions;
    }

    case "noResults": {
      return generateNoResultActions(result);
    }

    case "read": {
      const actions = [
        shellAction(
          "Search within this document's content",
          "poink",
          "search",
          result.title,
          "--expand",
          "2000",
        ),
      ];
      if (result.tags.length > 0) {
        actions.push(
          shellAction(
            "Browse documents with same tag",
            "poink",
            "list",
            "--tag",
            result.tags[0],
          ),
        );
      }
      actions.push(
        shellAction(
          "Find related concepts",
          "poink",
          "taxonomy",
          "search",
          result.title,
        ),
      );
      return actions;
    }

    case "list": {
      const actions: NextAction[] = [];
      if (result.firstDoc) {
        actions.push(
          shellAction(
            "Read the first listed document",
            "poink",
            "read",
            result.firstDoc.id,
          ),
        );
      }
      actions.push(
        shellAction("Search the library", "poink", "search", "your query here"),
      );
      return actions;
    }

    case "stats": {
      return [
        shellAction(
          "Search the library",
          "poink",
          "search",
          "your question here",
        ),
        shellAction("Browse all documents", "poink", "list"),
        shellAction("Browse taxonomy concepts", "poink", "taxonomy", "list"),
        shellAction("Check database health", "poink", "doctor"),
      ];
    }

    case "taxonomySearch": {
      const actions: NextAction[] = [];
      if (result.matches.length > 0) {
        actions.push(
          shellAction(
            "Navigate concept hierarchy",
            "poink",
            "taxonomy",
            "tree",
            result.matches[0].id,
          ),
        );
      } else {
        actions.push(
          shellAction("Browse all concepts", "poink", "taxonomy", "list"),
        );
      }
      actions.push(
        shellAction(
          "Search documents for this concept",
          "poink",
          "search",
          result.query,
        ),
      );
      return actions;
    }

    case "taxonomyList": {
      return [
        shellAction("View full concept tree", "poink", "taxonomy", "tree"),
        shellAction(
          "Search concepts",
          "poink",
          "taxonomy",
          "search",
          "your query",
        ),
      ];
    }

    case "taxonomyTree": {
      return [
        shellAction("View full concept tree", "poink", "taxonomy", "tree"),
      ];
    }

    case "add": {
      return [
        shellAction("Read the new document", "poink", "read", result.id),
        shellAction(
          "Search for related content",
          "poink",
          "search",
          result.title,
        ),
        shellAction("Apply tags", "poink", "tag", result.id, "tag1,tag2"),
      ];
    }

    case "remove": {
      return [
        shellAction("Browse remaining documents", "poink", "list"),
        shellAction("Verify counts", "poink", "stats"),
      ];
    }

    case "tag": {
      const actions = [
        shellAction(
          "Read document metadata",
          "poink",
          "read",
          result.title,
        ),
      ];
      const firstTag = result.tags[0];
      if (firstTag) {
        actions.push(
          shellAction("Browse by tag", "poink", "list", "--tag", firstTag),
        );
      }
      return actions;
    }

    case "doctor": {
      const actions: NextAction[] = [];
      if (!result.healthy) {
        actions.push(
          shellAction("Attempt auto-repair", "poink", "doctor", "--fix"),
        );
      }
      const missing = result.chunkerMissing ?? 0;
      const mismatch = result.chunkerMismatch ?? 0;

      if (mismatch > 0) {
        actions.push(
          shellAction(
            "Preview docs with stale chunker metadata",
            "poink",
            "rechunk",
            "--dry-run",
          ),
          shellAction(
            "Apply rechunk (rebuild chunks + embeddings)",
            "poink",
            "rechunk",
          ),
        );
      }

      if (missing > 0) {
        actions.push(
          shellAction(
            "Preview docs missing chunker metadata (upgrade sweep)",
            "poink",
            "rechunk",
            "--dry-run",
            "--include-missing",
          ),
          shellAction(
            "Rechunk a small batch (expensive)",
            "poink",
            "rechunk",
            "--include-missing",
            "--max-docs",
            "25",
          ),
        );
      }
      actions.push(shellAction("Verify counts", "poink", "stats"));
      return actions;
    }

    case "config": {
      return [shellAction("Show config", "poink", "config", "show")];
    }

    case "check": {
      return [shellAction("Check library stats", "poink", "stats")];
    }

    case "repair": {
      return [shellAction("Re-run health check", "poink", "doctor")];
    }

    case "reindex": {
      return [shellAction("Verify counts", "poink", "stats")];
    }

    case "rechunk": {
      if (result.dryRun) {
        if (result.includeMissing) {
          return [
            shellAction(
              "Rechunk a small batch (rebuild chunks + embeddings)",
              "poink",
              "rechunk",
              "--include-missing",
              "--max-docs",
              "25",
            ),
          ];
        }

        const actions = [
          shellAction(
            "Apply rechunk (rebuild chunks + embeddings)",
            "poink",
            "rechunk",
          ),
        ];

        if ((result.skippedMissing ?? 0) > 0) {
          actions.push(
            shellAction(
              "Include missing-metadata docs in the plan",
              "poink",
              "rechunk",
              "--dry-run",
              "--include-missing",
            ),
          );
        }

        return actions;
      }
      return [shellAction("Verify counts", "poink", "stats")];
    }

    case "error": {
      return [
        shellAction("Check database health", "poink", "doctor"),
        shellAction(
          "Check embedding provider connectivity",
          "poink",
          "check",
        ),
        shellAction("Show available commands", "poink", "--help"),
      ];
    }

  }
}
