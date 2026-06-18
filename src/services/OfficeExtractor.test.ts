/**
 * OfficeExtractor Unit Tests
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Effect } from "effect";
import {
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  OfficeExtractor,
  OfficeExtractorLive,
} from "./OfficeExtractor.js";
import type { OfficeSourceFormat } from "./SourceFileType.js";
import { MAX_ODT_XML_BYTES } from "./SourceFileLimits.js";

const ZIP_DEFLATE_OPTIONS = {
  type: "uint8array",
  compression: "DEFLATE",
} as const;

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "office-extractor-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function sourceFormatForTestPath(path: string): OfficeSourceFormat {
  if (path.endsWith(".docx")) return "docx-package";
  if (path.endsWith(".fodt")) return "odt-flat-xml";
  return "odt-package";
}

function runExtract(path: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const extractor = yield* OfficeExtractor;
      return yield* extractor.extract(path, sourceFormatForTestPath(path));
    }).pipe(Effect.provide(OfficeExtractorLive)),
  );
}

function runProcess(path: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const extractor = yield* OfficeExtractor;
      return yield* extractor.process(path, sourceFormatForTestPath(path));
    }).pipe(Effect.provide(OfficeExtractorLive)),
  );
}

function writeTempFile(name: string, content: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, content, "utf-8");
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

function sampleFodtXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:text>
      <text:h text:outline-level="1">Research Notes</text:h>
      <text:p>This is a long OpenDocument paragraph with enough text to survive chunk filtering.</text:p>
      <text:p>It preserves text:s spaces<text:s text:c="3"/>and text:line-break markers<text:line-break/>inside content.</text:p>
      <text:h text:outline-level="1">Second Section</text:h>
      <text:p>Another long section paragraph for embeddings and retrieval tests.</text:p>
    </office:text>
  </office:body>
</office:document>`;
}

async function writeOdtFile(name: string): Promise<string> {
  const path = join(tempDir, name);
  const zip = new JSZip();
  zip.file("content.xml", sampleFodtXml());
  await writeFile(path, await zip.generateAsync(ZIP_DEFLATE_OPTIONS));
  return path;
}

async function writeDocxFile(name: string): Promise<string> {
  const path = join(tempDir, name);
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>DOCX Research Notes</w:t></w:r></w:p>
    <w:p><w:r><w:t>This paragraph is long enough to be extracted and embedded by the document pipeline.</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );
  await writeFile(path, await zip.generateAsync(ZIP_DEFLATE_OPTIONS));
  return path;
}

async function writeStyledDocxFile(name: string): Promise<string> {
  const path = join(tempDir, name);
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
  </w:style>
</w:styles>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Research Notes</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t>This paragraph belongs under the research notes heading.</w:t></w:r></w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
      <w:r><w:t>Methods</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t>This paragraph belongs under the methods heading.</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Accuracy</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>High</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
  );
  await writeFile(path, await zip.generateAsync({ type: "uint8array" }));
  return path;
}

describe("OfficeExtractor", () => {
  test("extracts sections from flat OpenDocument text XML", async () => {
    const path = writeTempFile("notes.fodt", sampleFodtXml());
    const result = await runExtract(path);

    expect(result.fileType).toBe("odt");
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].heading).toBe("Research Notes");
    expect(result.sections[0].text).toContain("OpenDocument paragraph");
    expect(result.sections[0].text).toContain("spaces and");
  });

  test("rejects flat OpenDocument XML that exceeds the extraction limit", async () => {
    const path = writeTempFile("oversized.fodt", sampleFodtXml());
    truncateSync(path, MAX_ODT_XML_BYTES + 1);

    await expect(runExtract(path)).rejects.toThrow(
      "Flat ODF XML size exceeds limit",
    );
  });

  test("extracts sections from zipped ODT content.xml", async () => {
    const path = await writeOdtFile("notes.odt");
    const result = await runExtract(path);

    expect(result.fileType).toBe("odt");
    expect(result.sectionCount).toBe(2);
    expect(result.sections[1].heading).toBe("Second Section");
  });

  test("rejects zipped ODT when content.xml declares excessive expansion", async () => {
    const zip = new JSZip();
    zip.file("content.xml", sampleFodtXml());
    const bytes = await zip.generateAsync(ZIP_DEFLATE_OPTIONS);
    const patched = patchCentralDirectoryUncompressedSize(
      bytes,
      "content.xml",
      21 * 1024 * 1024,
    );
    const path = join(tempDir, "oversized-content.odt");
    await writeFile(path, patched);

    await expect(runExtract(path)).rejects.toThrow(
      "ODF content.xml declared uncompressed size exceeds limit",
    );
  });

  test("rejects zipped ODT when content.xml underdeclares expansion", async () => {
    const zip = new JSZip();
    zip.file("content.xml", `<root>${"A".repeat(21 * 1024 * 1024)}</root>`);
    const bytes = await zip.generateAsync(ZIP_DEFLATE_OPTIONS);
    const patched = patchCentralDirectoryUncompressedSize(
      bytes,
      "content.xml",
      1024,
    );
    const path = join(tempDir, "underdeclared-content.odt");
    await writeFile(path, patched);

    await expect(runExtract(path)).rejects.toThrow(
      "Office ZIP entry content.xml failed validation",
    );
  });

  test("processes ODT sections into searchable chunks", async () => {
    const path = await writeOdtFile("chunked.odt");
    const result = await runProcess(path);

    expect(result.pageCount).toBe(2);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].content).toContain("Research Notes");
  });

  test("extracts raw text from DOCX files", async () => {
    const path = await writeDocxFile("notes.docx");
    const result = await runExtract(path);

    expect(result.fileType).toBe("docx");
    expect(result.sectionCount).toBe(1);
    expect(result.sections[0].text).toContain("DOCX Research Notes");
    expect(result.sections[0].text).toContain("document pipeline");
  });

  test("rejects DOCX entries with excessive declared expansion", async () => {
    const safePath = await writeDocxFile("safe-for-patching.docx");
    const bytes = new Uint8Array(await readFile(safePath));
    const patched = patchCentralDirectoryUncompressedSize(
      bytes,
      "word/document.xml",
      51 * 1024 * 1024,
    );
    const path = join(tempDir, "oversized-document.docx");
    await writeFile(path, patched);

    await expect(runExtract(path)).rejects.toThrow(
      "Office ZIP XML entry word/document.xml declared uncompressed size exceeds limit",
    );
  });

  test("preserves DOCX heading styles as sections", async () => {
    const path = await writeStyledDocxFile("styled-headings.docx");
    const result = await runExtract(path);

    expect(result.fileType).toBe("docx");
    expect(result.sectionCount).toBe(2);
    expect(result.sections[0].heading).toBe("Research Notes");
    expect(result.sections[0].text).toContain("research notes heading");
    expect(result.sections[1].heading).toBe("Methods");
    expect(result.sections[1].text).toContain("methods heading");
    expect(result.sections[1].text).toContain("| Metric | Value |");
    expect(result.sections[1].text).toContain("| Accuracy | High |");
  });

  test("preserves ODT table structure as markdown tables", async () => {
    const path = writeTempFile(
      "table.fodt",
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body>
    <office:text>
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
      <text:p>Paragraph after the table stays in the same section.</text:p>
    </office:text>
  </office:body>
</office:document>`,
    );

    const result = await runExtract(path);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].heading).toBe("Results");
    expect(result.sections[0].text).toContain("| Metric | Value |");
    expect(result.sections[0].text).toContain("| Recall | High |");
    expect(result.sections[0].text).toContain("Paragraph after the table");
  });

  test("processes large Office tables with repeated headers", async () => {
    const rows = Array.from(
      { length: 140 },
      (_, index) => `
        <table:table-row>
          <table:table-cell><text:p>Row ${index}</text:p></table:table-cell>
          <table:table-cell><text:p>Value ${index} with extra text</text:p></table:table-cell>
        </table:table-row>`,
    ).join("\n");
    const path = writeTempFile(
      "large-table.fodt",
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body>
    <office:text>
      <text:h text:outline-level="1">Large Results</text:h>
      <table:table>
        <table:table-row>
          <table:table-cell><text:p>Name</text:p></table:table-cell>
          <table:table-cell><text:p>Value</text:p></table:table-cell>
        </table:table-row>
        ${rows}
      </table:table>
    </office:text>
  </office:body>
</office:document>`,
    );

    const result = await runProcess(path);
    const tableChunks = result.chunks.filter((chunk) =>
      chunk.content.includes("| Name | Value |"),
    );

    expect(tableChunks.length).toBeGreaterThan(1);
    for (const chunk of tableChunks) {
      expect(chunk.content).toContain("| Name | Value |");
      expect(chunk.content).toContain("| --- | --- |");
    }
  });
});
