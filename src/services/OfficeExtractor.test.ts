import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Context, Effect } from "effect";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { LibraryConfig } from "../types.js";
import { OfficeExtractor, makeOfficeExtractor } from "./OfficeExtractor.js";
import type { OfficeSourceFormat } from "./SourceFileType.js";
import { MAX_ODT_XML_BYTES } from "./SourceFileLimits.js";

type OfficeExtractorService = Context.Tag.Service<typeof OfficeExtractor>;

const extractorLayer = makeOfficeExtractor(
  new LibraryConfig({
    libraryPath: ".",
    dbPath: ":memory:",
    chunkSize: 1000,
    chunkOverlap: 0,
  }),
);

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "office-extractor-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function sourceFormatForPath(path: string): OfficeSourceFormat {
  if (path.endsWith(".docx")) return "docx-package";
  if (path.endsWith(".fodt")) return "odt-flat-xml";
  return "odt-package";
}

function run<A>(
  path: string,
  use: (
    extractor: OfficeExtractorService,
    sourceFormat: OfficeSourceFormat,
  ) => Effect.Effect<A, unknown>,
) {
  return Effect.runPromise(
    OfficeExtractor.pipe(
      Effect.flatMap((extractor) => use(extractor, sourceFormatForPath(path))),
      Effect.provide(extractorLayer),
    ),
  );
}

const extract = (path: string) =>
  run(path, (extractor, format) => extractor.extract(path, format));
const processOffice = (path: string) =>
  run(path, (extractor, format) => extractor.process(path, format));

function writeTempFile(name: string, content: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

/** Writes a DEFLATE ZIP, optionally faking one entry's declared uncompressed size. */
async function writeZip(
  name: string,
  entries: Record<string, string>,
  declaredSize?: { entry: string; bytes: number },
): Promise<string> {
  const zip = new JSZip();
  for (const [entryName, content] of Object.entries(entries)) {
    zip.file(entryName, content);
  }
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
  const path = join(tempDir, name);
  await writeFile(
    path,
    declaredSize
      ? patchCentralDirectoryUncompressedSize(bytes, declaredSize.entry, declaredSize.bytes)
      : bytes,
  );
  return path;
}

function patchCentralDirectoryUncompressedSize(
  bytes: Uint8Array,
  entryName: string,
  uncompressedSize: number,
): Uint8Array {
  const patched = new Uint8Array(bytes);
  const view = new DataView(
    patched.buffer,
    patched.byteOffset,
    patched.byteLength,
  );
  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (let offset = 0; offset <= patched.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;

    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nextOffset =
      offset + 46 + fileNameLength + extraFieldLength + commentLength;
    if (nextOffset > patched.byteLength) {
      throw new Error("Central directory entry outside test ZIP bounds");
    }

    const fileNameStart = offset + 46;
    const name = decoder.decode(
      patched.subarray(fileNameStart, fileNameStart + fileNameLength),
    );
    if (name === entryName) {
      view.setUint32(offset + 24, uncompressedSize, true);
      return patched;
    }

    offset = nextOffset - 1;
  }

  throw new Error(`Test ZIP entry not found: ${entryName}`);
}

/** Wraps ODF body markup in a flat OpenDocument text document. */
function odfDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body>
    <office:text>${body}</office:text>
  </office:body>
</office:document>`;
}

const SAMPLE_ODF = odfDocument(`
  <text:h text:outline-level="1">Research Notes</text:h>
  <text:p>This is a long OpenDocument paragraph.</text:p>
  <text:p>It preserves text:s spaces<text:s text:c="3"/>and text:line-break markers<text:line-break/>inside content.</text:p>
  <text:h text:outline-level="1">Second Section</text:h>
  <text:p>Another section paragraph.</text:p>`);

const SAMPLE_ODF_SECTIONS = [
  {
    section: 1,
    heading: "Research Notes",
    text: "This is a long OpenDocument paragraph.\n\nIt preserves text:s spaces and text:line-break markers\ninside content.",
  },
  { section: 2, heading: "Second Section", text: "Another section paragraph." },
];

/** Minimal DOCX entries: content types, package rels, styles, and the given body. */
function docxEntries(body: string): Record<string, string> {
  const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="${wordNamespace}">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${wordNamespace}"><w:body>${body}</w:body></w:document>`,
  };
}

function docxParagraph(text: string, style?: string): string {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${properties}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function docxTable(rows: string[][]): string {
  const renderedRows = rows.map(
    (cells) =>
      `<w:tr>${cells.map((cell) => `<w:tc>${docxParagraph(cell)}</w:tc>`).join("")}</w:tr>`,
  );
  return `<w:tbl>${renderedRows.join("")}</w:tbl>`;
}

describe("OpenDocument extraction", () => {
  test.each([
    { name: "flat XML", write: () => writeTempFile("notes.fodt", SAMPLE_ODF) },
    {
      name: "zipped content.xml",
      write: () => writeZip("notes.odt", { "content.xml": SAMPLE_ODF }),
    },
  ])("extracts heading sections from $name", async ({ write }) => {
    await expect(extract(await write())).resolves.toEqual({
      sections: SAMPLE_ODF_SECTIONS,
      sectionCount: 2,
    });
  });

  test("renders tables as Markdown within the current section", async () => {
    const path = writeTempFile(
      "table.fodt",
      odfDocument(`
        <text:h text:outline-level="1">Results</text:h>
        <table:table>
          <table:table-row>
            <table:table-cell><text:p>Metric</text:p></table:table-cell>
            <table:table-cell><text:p>Value</text:p></table:table-cell>
          </table:table-row>
          <table:table-row>
            <table:table-cell><text:p>Recall</text:p></table:table-cell>
            <table:table-cell><text:p>High</text:p></table:table-cell>
          </table:table-row>
        </table:table>
        <text:p>Paragraph after the table stays in the same section.</text:p>`),
    );

    const result = await extract(path);

    expect(result.sections).toEqual([
      {
        section: 1,
        heading: "Results",
        text: "| Metric | Value |\n| --- | --- |\n| Recall | High |\n\nParagraph after the table stays in the same section.",
      },
    ]);
  });

  test("processes sections into heading-prefixed chunks", async () => {
    const path = await writeZip("chunked.odt", { "content.xml": SAMPLE_ODF });

    await expect(processOffice(path)).resolves.toEqual({
      pageCount: 2,
      chunks: [
        {
          page: 1,
          chunkIndex: 0,
          content:
            "# Research Notes\n\nThis is a long OpenDocument paragraph.\n\nIt preserves text:s spaces and text:line-break markers inside content.",
        },
        {
          page: 2,
          chunkIndex: 0,
          content: "# Second Section\n\nAnother section paragraph.",
        },
      ],
    });
  });

  test("splits large tables into chunks that each repeat the header", async () => {
    const rows = Array.from(
      { length: 140 },
      (_, index) => `
        <table:table-row>
          <table:table-cell><text:p>Row ${index}</text:p></table:table-cell>
          <table:table-cell><text:p>Value ${index} with extra text</text:p></table:table-cell>
        </table:table-row>`,
    ).join("");
    const path = writeTempFile(
      "large-table.fodt",
      odfDocument(`
        <text:h text:outline-level="1">Large Results</text:h>
        <table:table>
          <table:table-row>
            <table:table-cell><text:p>Name</text:p></table:table-cell>
            <table:table-cell><text:p>Value</text:p></table:table-cell>
          </table:table-row>
          ${rows}
        </table:table>`),
    );

    const result = await processOffice(path);

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.content).toContain("| Name | Value |\n| --- | --- |\n| Row ");
    }
  });
});

describe("DOCX extraction", () => {
  test("extracts unstyled paragraphs as one untitled section", async () => {
    const path = await writeZip(
      "notes.docx",
      docxEntries(
        docxParagraph("DOCX Research Notes") +
          docxParagraph("This paragraph is extracted by the document pipeline."),
      ),
    );

    await expect(extract(path)).resolves.toEqual({
      sections: [
        {
          section: 1,
          heading: "",
          text: "DOCX Research Notes\n\nThis paragraph is extracted by the document pipeline.",
        },
      ],
      sectionCount: 1,
    });
  });

  test("turns heading styles into sections and tables into Markdown", async () => {
    const path = await writeZip(
      "styled.docx",
      docxEntries(
        docxParagraph("Research Notes", "Heading1") +
          docxParagraph("This paragraph belongs under the research notes heading.") +
          docxParagraph("Methods", "Heading2") +
          docxParagraph("This paragraph belongs under the methods heading.") +
          docxTable([
            ["Metric", "Value"],
            ["Accuracy", "High"],
          ]),
      ),
    );

    const result = await extract(path);

    expect(result.sections).toEqual([
      {
        section: 1,
        heading: "Research Notes",
        text: "This paragraph belongs under the research notes heading.",
      },
      {
        section: 2,
        heading: "Methods",
        text: "This paragraph belongs under the methods heading.\n\n| Metric | Value |\n| --- | --- |\n| Accuracy | High |",
      },
    ]);
  });
});

describe("size limits", () => {
  test("rejects flat OpenDocument XML that exceeds the extraction limit", async () => {
    const path = writeTempFile("oversized.fodt", SAMPLE_ODF);
    truncateSync(path, MAX_ODT_XML_BYTES + 1);

    await expect(extract(path)).rejects.toThrow("Flat ODF XML size exceeds limit");
  });

  test.each([
    {
      name: "ODT content.xml declaring excessive expansion",
      file: "declared.odt",
      entries: () => ({ "content.xml": SAMPLE_ODF }),
      declaredSize: { entry: "content.xml", bytes: 21 * 1024 * 1024 },
      error: "ODF content.xml declared uncompressed size exceeds limit",
    },
    {
      name: "ODT content.xml underdeclaring expansion",
      file: "underdeclared.odt",
      entries: () => ({
        "content.xml": `<root>${"A".repeat(21 * 1024 * 1024)}</root>`,
      }),
      declaredSize: { entry: "content.xml", bytes: 1024 },
      error: "Office ZIP entry content.xml failed validation",
    },
    {
      name: "DOCX document.xml declaring excessive expansion",
      file: "declared.docx",
      entries: () => docxEntries(docxParagraph("Body")),
      declaredSize: { entry: "word/document.xml", bytes: 51 * 1024 * 1024 },
      error:
        "Office ZIP XML entry word/document.xml declared uncompressed size exceeds limit",
    },
  ])("rejects $name", async ({ file, entries, declaredSize, error }) => {
    const path = await writeZip(file, entries(), declaredSize);

    await expect(extract(path)).rejects.toThrow(error);
  });
});
