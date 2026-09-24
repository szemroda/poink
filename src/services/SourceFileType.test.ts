import { afterEach, expect, test } from "vitest";
import { Effect, Either } from "effect";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  type DetectedSourceType,
  makeSourceFileTypeDetector,
  SourceFileTypeDetector,
  SourceFileTypeDetectorLive,
} from "./SourceFileType.js";
import {
  MAX_ODT_XML_BYTES,
  MAX_TEXT_SOURCE_BYTES,
} from "./SourceFileLimits.js";

const UNSUPPORTED = "UNSUPPORTED_SOURCE_FILE_TYPE";
const UNDETERMINED = "SOURCE_FILE_TYPE_UNDETERMINED";
type DetectionOutcome = DetectedSourceType | typeof UNSUPPORTED | typeof UNDETERMINED;

const PDF = { sourceFormat: "pdf", fileType: "pdf" } as const;
const MARKDOWN = { sourceFormat: "markdown-text", fileType: "markdown" } as const;
const TXT = { sourceFormat: "plain-text", fileType: "txt" } as const;
const FLAT_ODT = { sourceFormat: "odt-flat-xml", fileType: "odt" } as const;

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082",
  "hex",
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "source-type-"));
  tempDirs.push(directory);
  return join(directory, name);
}

/** Resolves to the detected type, or to the error tag when detection fails. */
async function detect(
  path: string,
  layer = SourceFileTypeDetectorLive,
): Promise<DetectionOutcome> {
  const result = await Effect.runPromise(
    SourceFileTypeDetector.pipe(
      Effect.flatMap((detector) => Effect.either(detector.detect(path))),
      Effect.provide(layer),
    ),
  );
  return Either.isRight(result) ? result.right : result.left._tag;
}

async function writeZip(
  path: string,
  entries: Record<string, string>,
): Promise<void> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    // ODF requires an uncompressed leading mimetype entry.
    zip.file(name, content, name === "mimetype" ? { compression: "STORE" } : {});
  }
  await writeFile(
    path,
    await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );
}

function openXmlContentTypes(partName: string, contentType: string): string {
  return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="${partName}" ContentType="${contentType}"/>
</Types>`;
}

test.each<{
  name: string;
  file: string;
  content: string | Buffer;
  size?: number;
  expected: DetectionOutcome;
}>([
  { name: "a PDF header despite a .docx extension", file: "report.docx", content: "%PDF-1.7\n", expected: PDF },
  {
    name: "a PDF header after leading bytes within the compatibility window",
    file: "leading.bin",
    content: `${"x".repeat(1023)}%PDF-1.7\n`,
    expected: PDF,
  },
  {
    name: "a PDF marker in prose as Markdown",
    file: "marker.md",
    content: "# Notes\n\nThe marker %PDF- appears in prose.\n",
    expected: MARKDOWN,
  },
  {
    name: "flat ODT XML with a BOM regardless of extension",
    file: "flat.data",
    content: `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<office:document
 xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 office:mimetype="application/vnd.oasis.opendocument.text">
 <office:body><office:text/></office:body>
</office:document>`,
    expected: FLAT_ODT,
  },
  {
    name: "flat ODT XML with comments and an arbitrary namespace prefix",
    file: "flat.data",
    content: `<!-- generated document -->
<odf:document
 xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 odf:mimetype="application/vnd.oasis.opendocument.text">
 <odf:body><odf:text/></odf:body>
</odf:document>`,
    expected: FLAT_ODT,
  },
  {
    name: "UTF-8 Markdown with a BOM",
    file: "notes.markdown",
    content: Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x44]),
    expected: MARKDOWN,
  },
  {
    name: "oversized Markdown via streamed UTF-8 validation",
    file: "oversized.md",
    content: "# Large document\n",
    size: MAX_ODT_XML_BYTES + 1,
    expected: MARKDOWN,
  },
  {
    name: "plain text with an upper-case .TXT extension",
    file: "notes.TXT",
    content: "Plain text note\n\nSecond paragraph.",
    expected: TXT,
  },
  { name: "an empty .txt file", file: "empty.txt", content: "", expected: TXT },
  {
    name: "an oversized XML candidate without extension fallback",
    file: "oversized.markdown",
    content: "<office:document",
    size: MAX_ODT_XML_BYTES + 1,
    expected: UNDETERMINED,
  },
  { name: "invalid UTF-8 Markdown", file: "invalid.md", content: Buffer.from([0xc3, 0x28]), expected: UNDETERMINED },
  { name: "invalid UTF-8 .txt", file: "invalid.txt", content: Buffer.from([0xc3, 0x28]), expected: UNSUPPORTED },
  { name: "PNG bytes in a .txt file", file: "image.txt", content: PNG_BYTES, expected: UNSUPPORTED },
  {
    name: "a .txt file with null bytes",
    file: "null-bytes.txt",
    content: "Header\u0000\u0000\u0000payload",
    expected: UNSUPPORTED,
  },
  {
    name: "a .txt file with control characters",
    file: "control-chars.txt",
    content: "abc\u0001\u0002\u0003\u0004def",
    expected: UNSUPPORTED,
  },
  {
    name: "a .txt file containing non-ODT XML",
    file: "data.txt",
    content: "<root><item>plain XML</item></root>",
    expected: UNSUPPORTED,
  },
  {
    name: "a .txt file above the TXT source limit",
    file: "oversized.txt",
    content: "Large text document\n",
    size: MAX_TEXT_SOURCE_BYTES + 1,
    expected: UNDETERMINED,
  },
  { name: "PNG bytes in a .pdf file", file: "image.pdf", content: PNG_BYTES, expected: UNSUPPORTED },
  { name: "text without a known extension", file: "unknown", content: "plain text", expected: UNDETERMINED },
  {
    name: "a malformed ZIP without extension fallback",
    file: "hostile.md",
    content: Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.alloc(256, 0xff)]),
    expected: UNSUPPORTED,
  },
])("classifies $name", async ({ file, content, size, expected }) => {
  const path = tempPath(file);
  writeFileSync(path, content);
  if (size !== undefined) truncateSync(path, size);

  await expect(detect(path)).resolves.toEqual(expected);
});

test.each<{
  name: string;
  file: string;
  entries: Record<string, string>;
  expected: DetectionOutcome;
}>([
  {
    name: "DOCX without an extension",
    file: "document",
    entries: {
      "[Content_Types].xml": openXmlContentTypes(
        "/word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      ),
      "word/document.xml": "<w:document/>",
    },
    expected: { sourceFormat: "docx-package", fileType: "docx" },
  },
  {
    name: "an ODT package with a misleading extension",
    file: "notes.bin",
    entries: {
      mimetype: "application/vnd.oasis.opendocument.text",
      "content.xml": "<office:document-content/>",
    },
    expected: { sourceFormat: "odt-package", fileType: "odt" },
  },
  {
    name: "XLSX named .md",
    file: "misleading.md",
    entries: {
      "[Content_Types].xml": openXmlContentTypes(
        "/xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      ),
      "xl/workbook.xml": "<workbook/>",
    },
    expected: UNSUPPORTED,
  },
  {
    name: "PPTX named .md",
    file: "misleading.md",
    entries: {
      "[Content_Types].xml": openXmlContentTypes(
        "/ppt/presentation.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      ),
      "ppt/presentation.xml": "<presentation/>",
    },
    expected: UNSUPPORTED,
  },
  {
    name: "a generic ZIP named .md",
    file: "misleading.md",
    entries: { "hello.txt": "hello" },
    expected: UNSUPPORTED,
  },
  {
    name: "a non-text ODF package named .md",
    file: "misleading.md",
    entries: {
      mimetype: "application/vnd.oasis.opendocument.spreadsheet",
      "content.xml": "<office:document/>",
    },
    expected: UNSUPPORTED,
  },
])("classifies ZIP content: $name", async ({ file, entries, expected }) => {
  const path = tempPath(file);
  await writeZip(path, entries);

  await expect(detect(path)).resolves.toEqual(expected);
});

test("does not use extension fallback after primary detection throws", async () => {
  const path = tempPath("notes.md");
  writeFileSync(path, "# Valid Markdown\n");
  const failingDetector = makeSourceFileTypeDetector(async () => {
    throw new Error("simulated detector safety failure");
  });

  await expect(detect(path, failingDetector)).resolves.toBe(UNDETERMINED);
});
