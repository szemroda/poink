import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Context, Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryConfig } from "../types.js";
import {
  MarkdownExtractor,
  makeMarkdownExtractor,
} from "./MarkdownExtractor.js";

type MarkdownExtractorService = Context.Tag.Service<typeof MarkdownExtractor>;

const extractorLayer = makeMarkdownExtractor(
  new LibraryConfig({
    libraryPath: ".",
    dbPath: ":memory:",
    chunkSize: 1000,
    chunkOverlap: 0,
  }),
);

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "md-extractor-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

let fileCounter = 0;

function writeMarkdown(content: string): string {
  const path = join(tempDir, `doc-${fileCounter++}.md`);
  writeFileSync(path, content, "utf-8");
  return path;
}

function run<A, E>(use: (extractor: MarkdownExtractorService) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    MarkdownExtractor.pipe(Effect.flatMap(use), Effect.provide(extractorLayer)),
  );
}

const extract = (content: string) =>
  run((extractor) => extractor.extract(writeMarkdown(content)));
const processMarkdown = (content: string) =>
  run((extractor) => extractor.process(writeMarkdown(content)));

const NESTED_HEADINGS = `# Parent

Intro.

## Child

Details.

### Grandchild

Nested details.

# Other

### Skipped

Deep.
`;

describe("frontmatter", () => {
  test.each([
    {
      name: "title, description and tags",
      markdown:
        "---\ntitle: My Document\ndescription: A test document\ntags:\n  - test\n  - markdown\n---\n\n# Content",
      expected: {
        title: "My Document",
        description: "A test document",
        tags: ["test", "markdown"],
      },
    },
    {
      name: "extra fields",
      markdown:
        "---\ntitle: Doc\nauthor: John Doe\ncustom_field: custom_value\n---\n\nContent.",
      expected: {
        title: "Doc",
        author: "John Doe",
        custom_field: "custom_value",
      },
    },
    {
      name: "only string-typed title, description and tags",
      markdown:
        "---\ntitle: 123\ndescription: false\ntags:\n  - a\n  - 1\n---\n\nContent.",
      expected: { tags: ["a"] },
    },
    {
      name: "no frontmatter",
      markdown: "# Just a heading\n\nSome content.",
      expected: {},
    },
  ])("extracts $name", async ({ markdown, expected }) => {
    const path = writeMarkdown(markdown);

    await expect(
      run((extractor) => extractor.extractFrontmatter(path)),
    ).resolves.toEqual(expected);
  });

  test("ignores malformed YAML and still extracts the body", async () => {
    const result = await extract(
      "---\ntitle: [unclosed bracket\ninvalid: yaml: here\n---\n\nContent after bad frontmatter.\n",
    );

    expect(result.frontmatter).toEqual({});
    expect(result.sections.map((section) => section.text)).toEqual([
      "Content after bad frontmatter.",
    ]);
  });
});

describe("section extraction", () => {
  test("splits sections by heading and compacts skipped heading levels", async () => {
    const result = await extract(NESTED_HEADINGS);

    expect(result.sectionCount).toBe(5);
    expect(
      result.sections.map(({ heading, headingLevel, headingPath, text }) => ({
        heading,
        headingLevel,
        headingPath,
        text,
      })),
    ).toEqual([
      { heading: "Parent", headingLevel: 1, headingPath: ["Parent"], text: "Intro." },
      { heading: "Child", headingLevel: 2, headingPath: ["Parent", "Child"], text: "Details." },
      {
        heading: "Grandchild",
        headingLevel: 3,
        headingPath: ["Parent", "Child", "Grandchild"],
        text: "Nested details.",
      },
      { heading: "Other", headingLevel: 1, headingPath: ["Other"], text: "" },
      { heading: "Skipped", headingLevel: 3, headingPath: ["Other", "Skipped"], text: "Deep." },
    ]);
  });

  test("keeps content before the first heading as its own section", async () => {
    const result = await extract(
      "Some intro text before any heading.\n\n# First Heading\n\nContent after heading.\n",
    );

    expect(result.sections).toEqual([
      {
        section: 1,
        heading: "",
        headingLevel: 0,
        headingPath: [],
        text: "Some intro text before any heading.",
      },
      {
        section: 2,
        heading: "First Heading",
        headingLevel: 1,
        headingPath: ["First Heading"],
        text: "Content after heading.",
      },
    ]);
  });

  test("treats a document without headings as one section", async () => {
    const result = await extract(
      "Just plain text content.\n\nWith multiple paragraphs.",
    );

    expect(result.sections).toEqual([
      {
        section: 1,
        heading: "",
        headingLevel: 0,
        headingPath: [],
        text: "Just plain text content.\n\nWith multiple paragraphs.",
      },
    ]);
  });

  test("renders GFM tables as normalized Markdown tables", async () => {
    const result = await extract(`# GFM Test

| Column 1 | Column 2 |
|----------|----------|
| Cell 1   | Cell 2   |

~~strikethrough~~ and **bold**.
`);

    expect(result.sections.map((section) => section.text)).toEqual([
      "| Column 1 | Column 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |\n\n~~strikethrough~~ and **bold**.",
    ]);
  });

  test.each([
    { name: "empty", markdown: "" },
    { name: "whitespace-only", markdown: "   \n\n   \t\t\n   " },
  ])("returns no sections for an $name file", async ({ markdown }) => {
    const result = await extract(markdown);

    expect(result.sections).toEqual([]);
    expect(result.sectionCount).toBe(0);
  });

  test("fails with MarkdownNotFoundError for a missing file", async () => {
    const path = join(tempDir, "does-not-exist.md");

    await expect(
      run((extractor) => Effect.flip(extractor.extract(path))),
    ).resolves.toMatchObject({ _tag: "MarkdownNotFoundError" });
  });
});

describe("processing", () => {
  test("returns frontmatter and one chunk per section", async () => {
    const result = await processMarkdown(`---
title: Integration Test
tags:
  - test
---

# Section One

Content for section one.

# Section Two

Content for section two.
`);

    expect(result).toEqual({
      pageCount: 2,
      frontmatter: { title: "Integration Test", tags: ["test"] },
      chunks: [
        { page: 1, chunkIndex: 0, content: "# Section One\n\nContent for section one." },
        { page: 2, chunkIndex: 0, content: "# Section Two\n\nContent for section two." },
      ],
    });
  });

  test("prefixes chunks with the heading ancestry", async () => {
    const result = await processMarkdown(NESTED_HEADINGS);

    expect(result.chunks.map((chunk) => chunk.content)).toEqual([
      "# Parent\n\nIntro.",
      "# Parent > Child\n\nDetails.",
      "# Parent > Child > Grandchild\n\nNested details.",
      "# Other",
      "# Other > Skipped\n\nDeep.",
    ]);
  });

  test("returns no chunks for a frontmatter-only file", async () => {
    const result = await processMarkdown("---\ntitle: Only Frontmatter\n---\n");

    expect(result).toMatchObject({
      pageCount: 0,
      chunks: [],
      frontmatter: { title: "Only Frontmatter" },
    });
  });

  test("keeps markdown structure: code fences, indentation, lists and quotes", async () => {
    const result = await processMarkdown(`# Code Example

Run \`npm i\` first.

\`\`\`javascript
function hello() {
    return true;
}
\`\`\`

    indented code

- apple
    - green   apple
- banana

> quote one
>
> quote two
`);

    expect(result.chunks.map((chunk) => chunk.content)).toEqual([
      `# Code Example

Run \`npm i\` first.

\`\`\`javascript
function hello() {
    return true;
}
\`\`\`

\`\`\`
indented code
\`\`\`

- apple
    - green apple
- banana

> quote one
>
> quote two`,
    ]);
  });

  test("fences code that contains backtick fences with a longer fence", async () => {
    const block = "````md\n```\ninner\n```\n````";

    const result = await processMarkdown(`${block}\n`);

    expect(result.chunks.map((chunk) => chunk.content)).toEqual([block]);
  });

  test("splits large tables into chunks that each repeat the header", async () => {
    const rows = Array.from(
      { length: 140 },
      (_, index) => `| Row ${index} | Value ${index} with some extra text |`,
    ).join("\n");

    const result = await processMarkdown(
      `# Table Section\n\n| Name | Value |\n|------|-------|\n${rows}\n`,
    );

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.content).toContain("| Name | Value |\n| --- | --- |\n| Row ");
    }
  });

  test("splits long prose on paragraph boundaries", async () => {
    const paragraphs = ["First", "Second", "Third"].map((name) =>
      `${name} paragraph. `.repeat(50).trim(),
    );

    const result = await processMarkdown(`# Title\n\n${paragraphs.join("\n\n")}\n`);

    expect(result.chunks.map((chunk) => chunk.content)).toEqual([
      `# Title\n\n${paragraphs[0]}`,
      paragraphs[1],
      paragraphs[2],
    ]);
  });

  test("strips null bytes from headings and body", async () => {
    const result = await processMarkdown(
      "# Title with\x00null bytes\n\nContent with\x00\x00multiple\x00null bytes.\n",
    );

    expect(result.chunks.map((chunk) => chunk.content)).toEqual([
      "# Title withnull bytes\n\nContent withmultiplenull bytes.",
    ]);
  });
});
