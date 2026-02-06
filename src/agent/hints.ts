/**
 * HATEOAS-style hint engine for pdf-brain CLI.
 *
 * Pure function: CommandResult discriminated union in, string[] hints out.
 */

export type CommandResult =
  | {
      _tag: "search";
      query: string;
      results: { title: string; docId: string; score: number }[];
      concepts: { id: string; prefLabel: string }[];
      hadExpand: boolean;
      wasFts: boolean;
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
  | { _tag: "doctor"; healthy: boolean }
  | { _tag: "config"; subcommand: string }
  | { _tag: "tag"; title: string; tags: string[] }
  | { _tag: "check"; reachable: boolean }
  | { _tag: "repair"; orphanedChunks: number; orphanedEmbeddings: number }
  | { _tag: "reindex"; count: number; errors: number };

/**
 * Generate contextual next-action hints from a command result.
 * Returns an array of copy-pasteable command strings with descriptions.
 */
export function generateHints(result: CommandResult): string[] {
  switch (result._tag) {
    case "search": {
      const hints: string[] = [];
      if (result.results.length > 0) {
        const top = result.results[0];
        hints.push(
          `\`pdf-brain read "${top.title}"\` -- Full metadata for top result`
        );
        if (!result.hadExpand) {
          hints.push(
            `\`pdf-brain search "${result.query}" --expand 2000\` -- Get expanded context around matches`
          );
        }
      }
      if (result.concepts.length > 0) {
        const topConcept = result.concepts[0];
        hints.push(
          `\`pdf-brain taxonomy tree "${topConcept.id}"\` -- Navigate concept hierarchy`
        );
      }
      if (result.results.length > 0 && !result.wasFts) {
        hints.push(
          `\`pdf-brain search "${result.query}" --fts\` -- Try keyword matching instead`
        );
      }
      if (result.results.length === 0 && result.concepts.length === 0) {
        return generateHints({
          _tag: "noResults",
          query: result.query,
          wasFts: result.wasFts,
        });
      }
      return hints;
    }

    case "noResults": {
      const hints: string[] = [];
      if (!result.wasFts) {
        hints.push(
          `\`pdf-brain search "${result.query}" --fts\` -- Try full-text keyword search`
        );
      } else {
        hints.push(
          `\`pdf-brain search "${result.query}"\` -- Try semantic vector search`
        );
      }
      hints.push(
        `\`pdf-brain list\` -- Browse all documents`,
        `\`pdf-brain taxonomy search "${result.query}"\` -- Search taxonomy concepts`
      );
      return hints;
    }

    case "read": {
      const hints: string[] = [];
      hints.push(
        `\`pdf-brain search "${result.title}" --expand 2000\` -- Search within this document's content`
      );
      if (result.tags.length > 0) {
        hints.push(
          `\`pdf-brain list --tag "${result.tags[0]}"\` -- Browse documents with same tag`
        );
      }
      hints.push(
        `\`pdf-brain taxonomy search "${result.title}"\` -- Find related concepts`
      );
      return hints;
    }

    case "list": {
      const hints: string[] = [];
      if (result.firstDoc) {
        hints.push(
          `\`pdf-brain read "${result.firstDoc.title}"\` -- View document details`
        );
      }
      hints.push(
        `\`pdf-brain search "<query>"\` -- Search across all documents`
      );
      if (!result.tag) {
        hints.push(
          `\`pdf-brain taxonomy list\` -- Browse concept categories`
        );
      }
      return hints;
    }

    case "stats": {
      const hints: string[] = [];
      hints.push(
        `\`pdf-brain search "<query>"\` -- Search across ${result.documents} documents`,
        `\`pdf-brain list\` -- Browse all documents`,
        `\`pdf-brain taxonomy list\` -- Browse concept taxonomy`,
        `\`pdf-brain doctor\` -- Run health check`
      );
      return hints;
    }

    case "taxonomySearch": {
      const hints: string[] = [];
      if (result.matches.length > 0) {
        const top = result.matches[0];
        hints.push(
          `\`pdf-brain taxonomy tree "${top.id}"\` -- Navigate hierarchy from "${top.prefLabel}"`
        );
        hints.push(
          `\`pdf-brain search "${top.prefLabel}"\` -- Find documents tagged with this concept`
        );
      } else {
        hints.push(
          `\`pdf-brain taxonomy list\` -- Browse all concepts`,
          `\`pdf-brain search "${result.query}"\` -- Search documents instead`
        );
      }
      return hints;
    }

    case "taxonomyList": {
      const hints: string[] = [];
      hints.push(
        `\`pdf-brain taxonomy list --tree\` -- Show hierarchy tree view`,
        `\`pdf-brain taxonomy search "<query>"\` -- Find specific concepts`,
        `\`pdf-brain search "<query>"\` -- Search documents by content`
      );
      return hints;
    }

    case "taxonomyTree": {
      const hints: string[] = [];
      hints.push(
        `\`pdf-brain taxonomy search "<query>"\` -- Find concepts by keyword`,
        `\`pdf-brain search "<query>"\` -- Search documents by content`
      );
      if (result.rootId) {
        hints.push(
          `\`pdf-brain taxonomy tree\` -- View full concept tree`
        );
      }
      return hints;
    }

    case "add": {
      return [
        `\`pdf-brain read "${result.title}"\` -- View document details`,
        `\`pdf-brain search "${result.title}" --expand 2000\` -- Search within this document`,
        `\`pdf-brain tag "${result.id}" "topic1,topic2"\` -- Add tags`,
      ];
    }

    case "remove": {
      return [
        `\`pdf-brain list\` -- Browse remaining documents`,
        `\`pdf-brain stats\` -- Check library statistics`,
      ];
    }

    case "tag": {
      return [
        `\`pdf-brain read "${result.title}"\` -- View updated document`,
        `\`pdf-brain list --tag "${result.tags[0]}"\` -- Browse documents with this tag`,
      ];
    }

    case "doctor": {
      const hints: string[] = [];
      if (!result.healthy) {
        hints.push(
          `\`pdf-brain doctor --fix\` -- Auto-repair detected issues`
        );
      }
      hints.push(
        `\`pdf-brain stats\` -- Check library statistics`,
        `\`pdf-brain search "<query>"\` -- Search documents`
      );
      return hints;
    }

    case "config": {
      return [
        `\`pdf-brain config show\` -- View all settings`,
        `\`pdf-brain config set embedding.model <model>\` -- Change embedding model`,
        `\`pdf-brain stats\` -- Check library statistics`,
      ];
    }

    case "check": {
      const hints: string[] = [];
      if (result.reachable) {
        hints.push(
          `\`pdf-brain search "<query>"\` -- Search documents`,
          `\`pdf-brain stats\` -- Check library statistics`
        );
      } else {
        hints.push(
          `\`pdf-brain doctor\` -- Run full health check`,
          `\`pdf-brain config show\` -- Check configuration`
        );
      }
      return hints;
    }

    case "repair": {
      return [
        `\`pdf-brain doctor\` -- Run full health check`,
        `\`pdf-brain stats\` -- Check library statistics`,
      ];
    }

    case "reindex": {
      return [
        `\`pdf-brain stats\` -- Check updated statistics`,
        `\`pdf-brain search "<query>"\` -- Test search with new embeddings`,
      ];
    }

    case "error": {
      return [
        `\`pdf-brain doctor\` -- Run health check`,
        `\`pdf-brain check\` -- Verify embedding provider`,
        `\`pdf-brain --help\` -- View all commands`,
      ];
    }

    default: {
      const _exhaustive: never = result;
      return [];
    }
  }
}
