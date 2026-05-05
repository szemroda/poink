/**
 * OfficeExtractor Unit Tests
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { OfficeExtractor, OfficeExtractorLive } from "./OfficeExtractor.js";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "office-extractor-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runExtract(path: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const extractor = yield* OfficeExtractor;
      return yield* extractor.extract(path);
    }).pipe(Effect.provide(OfficeExtractorLive)),
  );
}

function runProcess(path: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const extractor = yield* OfficeExtractor;
      return yield* extractor.process(path);
    }).pipe(Effect.provide(OfficeExtractorLive)),
  );
}

function writeTempFile(name: string, content: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, content, "utf-8");
  return path;
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
  await Bun.write(path, await zip.generateAsync({ type: "uint8array" }));
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
  await Bun.write(path, await zip.generateAsync({ type: "uint8array" }));
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

  test("extracts sections from zipped ODT content.xml", async () => {
    const path = await writeOdtFile("notes.odt");
    const result = await runExtract(path);

    expect(result.fileType).toBe("odt");
    expect(result.sectionCount).toBe(2);
    expect(result.sections[1].heading).toBe("Second Section");
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
});
