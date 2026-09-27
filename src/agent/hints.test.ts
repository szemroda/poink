import { describe, expect, test } from "vitest";
import {
  generateHints,
  generateNextActions,
  type CommandResult,
} from "./hints.js";
import { formatHintBlock } from "./format.js";

/** Returns the backticked command of each hint, dropping its description. */
function hintCommands(result: CommandResult): string[] {
  return generateHints(result).map((hint) => hint.slice(1, hint.indexOf("`", 1)));
}

type SearchResult = Extract<CommandResult, { _tag: "search" }>;

function searchResult(overrides: Partial<SearchResult>): SearchResult {
  return {
    _tag: "search",
    query: "error handling",
    results: [{ title: "Release It!", docId: "doc-1", chunkId: "chunk-1" }],
    concepts: [],
    hadExpand: false,
    wasFts: false,
    ...overrides,
  };
}

describe("generateHints", () => {
  test.each<[string, CommandResult, string[]]>([
    [
      "search with results suggests read, expand, and keyword search",
      searchResult({}),
      [
        'poink read "Release It!"',
        'poink search "error handling" --expand 2000',
        'poink search "error handling" --fts',
      ],
    ],
    [
      "search does not repeat --expand or --fts once used",
      searchResult({ hadExpand: true, wasFts: true }),
      ['poink read "Release It!"'],
    ],
    [
      "search with concepts suggests taxonomy navigation",
      searchResult({
        hadExpand: true,
        wasFts: true,
        concepts: [{ id: "software/design-patterns" }],
      }),
      ['poink read "Release It!"', 'poink taxonomy tree "software/design-patterns"'],
    ],
    [
      "search without matches falls back to no-result hints",
      searchResult({ results: [] }),
      [
        'poink search "error handling" --fts',
        "poink list",
        'poink taxonomy search "error handling"',
      ],
    ],
    [
      "search without matches after FTS suggests vector search",
      searchResult({ query: "missing thing", results: [], wasFts: true }),
      ['poink search "missing thing"', "poink list", 'poink taxonomy search "missing thing"'],
    ],
    [
      "read suggests the first tag",
      { _tag: "read", title: "Release It!", tags: ["resilience", "ops"] },
      [
        'poink search "Release It!" --expand 2000',
        'poink list --tag "resilience"',
        'poink taxonomy search "Release It!"',
      ],
    ],
    [
      "untagged list suggests taxonomy browsing",
      { _tag: "list", firstDoc: { title: "DDIA", id: "doc-1" } },
      ['poink read "DDIA"', 'poink search "<query>"', "poink taxonomy list"],
    ],
    [
      "tag-filtered list skips taxonomy browsing",
      { _tag: "list", tag: "ml" },
      ['poink search "<query>"'],
    ],
    [
      "stats suggests search, browsing, and doctor",
      { _tag: "stats", documents: 100 },
      ['poink search "<query>"', "poink list", "poink taxonomy list", "poink doctor"],
    ],
    [
      "taxonomy list suggests tree and search",
      { _tag: "taxonomyList" },
      ["poink taxonomy tree", 'poink taxonomy search "<query>"', 'poink search "<query>"'],
    ],
    [
      "add suggests read, search, and tagging the new document",
      { _tag: "add", title: "New Book", id: "doc-new" },
      [
        'poink read "New Book"',
        'poink search "New Book" --expand 2000',
        'poink tag "doc-new" "topic1,topic2"',
      ],
    ],
    [
      "remove suggests list and stats",
      { _tag: "remove" },
      ["poink list", "poink stats"],
    ],
    [
      "taxonomy search with matches navigates the top match",
      {
        _tag: "taxonomySearch",
        query: "error",
        matches: [{ id: "programming/error-handling", prefLabel: "Error Handling" }],
      },
      ['poink taxonomy tree "programming/error-handling"', 'poink search "Error Handling"'],
    ],
    [
      "taxonomy search without matches suggests browsing",
      { _tag: "taxonomySearch", query: "nonexistent", matches: [] },
      ["poink taxonomy list", 'poink search "nonexistent"'],
    ],
    [
      "subtree view suggests the full tree",
      { _tag: "taxonomyTree", rootId: "software" },
      ['poink taxonomy search "<query>"', 'poink search "<query>"', "poink taxonomy tree"],
    ],
    [
      "unhealthy doctor suggests --fix and rechunking",
      { _tag: "doctor", healthy: false, chunkerMismatch: 1, chunkerMissing: 2 },
      [
        "poink doctor --fix",
        "poink rechunk --dry-run",
        "poink rechunk",
        "poink rechunk --dry-run --include-missing",
        "poink rechunk --include-missing --max-docs 25",
        "poink stats",
        'poink search "<query>"',
      ],
    ],
    [
      "healthy doctor does not suggest --fix",
      { _tag: "doctor", healthy: true },
      ["poink stats", 'poink search "<query>"'],
    ],
  ])("%s", (_name, result, expected) => {
    expect(hintCommands(result)).toEqual(expected);
  });

  // Mapped over every tag so adding a CommandResult variant forces a case here.
  const everyVariant: { [Tag in CommandResult["_tag"]]: Extract<CommandResult, { _tag: Tag }> } = {
    search: searchResult({}),
    searchPack: { _tag: "searchPack", queries: ["q"], results: [] },
    read: { _tag: "read", title: "T", tags: [] },
    list: { _tag: "list" },
    stats: { _tag: "stats", documents: 1 },
    taxonomySearch: { _tag: "taxonomySearch", query: "q", matches: [] },
    taxonomyList: { _tag: "taxonomyList" },
    taxonomyTree: { _tag: "taxonomyTree" },
    add: { _tag: "add", title: "T", id: "d" },
    remove: { _tag: "remove" },
    tag: { _tag: "tag", title: "T", tags: ["t"] },
    doctor: { _tag: "doctor", healthy: true },
    config: { _tag: "config" },
    check: { _tag: "check" },
    repair: { _tag: "repair" },
    reindex: { _tag: "reindex" },
    rechunk: { _tag: "rechunk", dryRun: false },
  };

  test.each(Object.values(everyVariant))("suggests at least one next step for $_tag", (result) => {
    expect(generateHints(result).length).toBeGreaterThan(0);
    expect(generateNextActions(result).length).toBeGreaterThan(0);
  });
});

describe("generateNextActions", () => {
  test("an embedding model change leads with the vector rebuild", () => {
    const result: CommandResult = { _tag: "config", embeddingChanged: true };
    expect(hintCommands(result)[0]).toBe("poink reindex");
    expect(generateNextActions(result)[0]).toMatchObject({
      argv: ["poink", "reindex"],
    });
  });

  test("search actions address the top result by id and chunk", () => {
    expect(generateNextActions(searchResult({ hadExpand: true, wasFts: true }))).toEqual([
      { kind: "shell", argv: ["poink", "read", "doc-1"], description: "Full metadata for top result" },
      { kind: "shell", argv: ["poink", "chunk", "get", "chunk-1"], description: "Fetch exact top chunk text" },
    ]);
  });
});

describe("formatHintBlock", () => {
  test("renders hints as a markdown blockquote with a library summary", () => {
    expect(
      formatHintBlock(["`poink list` -- Browse"], { documents: 42 }),
    ).toBe(
      [
        "",
        "---",
        "> **Next Actions**",
        "> - `poink list` -- Browse",
        ">",
        "> poink: 42 documents. `poink --help` for full reference.",
      ].join("\n"),
    );
  });

  test("footer omits the library summary without stats", () => {
    expect(formatHintBlock(["`cmd` -- desc"])).toBe(
      ["", "---", "> **Next Actions**", "> - `cmd` -- desc", ">", "> `poink --help` for full reference."].join("\n"),
    );
  });
});
