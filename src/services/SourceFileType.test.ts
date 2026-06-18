import { afterEach, describe, expect, test } from "vitest";
import { Effect } from "effect";
import {
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  makeSourceFileTypeDetector,
  SourceFileTypeDetector,
  SourceFileTypeDetectorLive,
} from "./SourceFileType.js";
import { MAX_ODT_XML_BYTES } from "./SourceFileLimits.js";

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

function detectWith(
  path: string,
  layer = SourceFileTypeDetectorLive,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const detector = yield* SourceFileTypeDetector;
      return yield* detector.detect(path);
    }).pipe(Effect.provide(layer)),
  );
}

function detect(path: string) {
  return detectWith(path);
}

function detectEither(
  path: string,
  layer = SourceFileTypeDetectorLive,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const detector = yield* SourceFileTypeDetector;
      return yield* Effect.either(detector.detect(path));
    }).pipe(Effect.provide(layer)),
  );
}

async function writeDocx(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file("word/document.xml", "<w:document/>");
  await writeFile(path, await zip.generateAsync({ type: "uint8array" }));
}

async function writeOdt(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text", {
    compression: "STORE",
  });
  zip.file("content.xml", "<office:document-content/>");
  await writeFile(
    path,
    await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );
}

async function writeZip(
  path: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  const zip = new JSZip();
  for (const [name, content] of entries) {
    zip.file(name, content);
  }
  await writeFile(path, await zip.generateAsync({ type: "uint8array" }));
}

test("detects supported binary content independently of extension", async () => {
  const pdf = tempPath("report.docx");
  writeFileSync(pdf, "%PDF-1.7\n");

  const docx = tempPath("document");
  await writeDocx(docx);

  const odt = tempPath("notes.bin");
  await writeOdt(odt);

  await expect(detect(pdf)).resolves.toEqual({
    sourceFormat: "pdf",
    fileType: "pdf",
  });
  await expect(detect(docx)).resolves.toEqual({
    sourceFormat: "docx-package",
    fileType: "docx",
  });
  await expect(detect(odt)).resolves.toEqual({
    sourceFormat: "odt-package",
    fileType: "odt",
  });
});

test("accepts a PDF marker after leading bytes within the compatibility window", async () => {
  const path = tempPath("leading.bin");
  writeFileSync(path, `${"x".repeat(1023)}%PDF-1.7\n`);

  await expect(detect(path)).resolves.toEqual({
    sourceFormat: "pdf",
    fileType: "pdf",
  });
});

test("does not classify arbitrary PDF marker text as a PDF header", async () => {
  const path = tempPath("marker.md");
  writeFileSync(path, "# Notes\n\nThe marker %PDF- appears in prose.\n");

  await expect(detect(path)).resolves.toEqual({
    sourceFormat: "markdown-text",
    fileType: "markdown",
  });
});

test("detects valid flat ODT XML independently of extension", async () => {
  const path = tempPath("flat.data");
  writeFileSync(
    path,
    `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<office:document
 xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 office:mimetype="application/vnd.oasis.opendocument.text">
 <office:body><office:text/></office:body>
</office:document>`,
    "utf8",
  );

  await expect(detect(path)).resolves.toEqual({
    sourceFormat: "odt-flat-xml",
    fileType: "odt",
  });
});

test("detects flat ODT with comments and an arbitrary namespace prefix", async () => {
  const path = tempPath("flat.data");
  writeFileSync(
    path,
    `<!-- generated document -->
<odf:document
 xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 odf:mimetype="application/vnd.oasis.opendocument.text">
 <odf:body><odf:text/></odf:body>
</odf:document>`,
    "utf8",
  );

  await expect(detect(path)).resolves.toEqual({
    sourceFormat: "odt-flat-xml",
    fileType: "odt",
  });
});

test("rejects oversized XML candidates without extension fallback", async () => {
  const path = tempPath("oversized.markdown");
  writeFileSync(path, "<office:document");
  truncateSync(path, MAX_ODT_XML_BYTES + 1);

  await expect(detectEither(path)).resolves.toMatchObject({
    _tag: "Left",
    left: { _tag: "SOURCE_FILE_TYPE_UNDETERMINED" },
  });
});

test("validates oversized Markdown as UTF-8 without DOM parsing", async () => {
  const path = tempPath("oversized.md");
  writeFileSync(path, "# Large document\n");
  truncateSync(path, MAX_ODT_XML_BYTES + 1);

  await expect(detect(path)).resolves.toEqual({
    sourceFormat: "markdown-text",
    fileType: "markdown",
  });
});

test("uses Markdown extension fallback only for valid UTF-8", async () => {
  const markdown = tempPath("notes.markdown");
  writeFileSync(markdown, Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x44]));
  await expect(detect(markdown)).resolves.toEqual({
    sourceFormat: "markdown-text",
    fileType: "markdown",
  });

  const invalid = tempPath("invalid.md");
  writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
  await expect(detectEither(invalid)).resolves.toMatchObject({
    _tag: "Left",
    left: { _tag: "SOURCE_FILE_TYPE_UNDETERMINED" },
  });
});

test("distinguishes known unsupported content from undetermined content", async () => {
  const png = tempPath("image.pdf");
  writeFileSync(
    png,
    Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082",
      "hex",
    ),
  );
  await expect(detectEither(png)).resolves.toMatchObject({
    _tag: "Left",
    left: { _tag: "UNSUPPORTED_SOURCE_FILE_TYPE" },
  });

  const unknown = tempPath("unknown");
  writeFileSync(unknown, "plain text", "utf8");
  await expect(detectEither(unknown)).resolves.toMatchObject({
    _tag: "Left",
    left: { _tag: "SOURCE_FILE_TYPE_UNDETERMINED" },
  });
});

test.each([
  {
    name: "XLSX",
    entries: [
      [
        "[Content_Types].xml",
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        </Types>`,
      ],
      ["xl/workbook.xml", "<workbook/>"],
    ] as const,
  },
  {
    name: "PPTX",
    entries: [
      [
        "[Content_Types].xml",
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
        </Types>`,
      ],
      ["ppt/presentation.xml", "<presentation/>"],
    ] as const,
  },
  {
    name: "generic ZIP",
    entries: [["hello.txt", "hello"]] as const,
  },
  {
    name: "non-text ODF package",
    entries: [
      ["mimetype", "application/vnd.oasis.opendocument.spreadsheet"],
      ["content.xml", "<office:document/>"],
    ] as const,
  },
])("rejects known unsupported $name content", async ({ entries }) => {
  const path = tempPath("misleading.md");
  await writeZip(path, entries);

  await expect(detectEither(path)).resolves.toMatchObject({
    _tag: "Left",
    left: { _tag: "UNSUPPORTED_SOURCE_FILE_TYPE" },
  });
});

test("does not use extension fallback after primary detection throws", async () => {
  const path = tempPath("notes.md");
  writeFileSync(path, "# Valid Markdown\n");
  const failingDetector = makeSourceFileTypeDetector(async () => {
    throw new Error("simulated detector safety failure");
  });

  await expect(detectEither(path, failingDetector)).resolves.toMatchObject({
    _tag: "Left",
    left: { _tag: "SOURCE_FILE_TYPE_UNDETERMINED" },
  });
});

test("rejects malformed ZIP content without extension fallback", async () => {
  const path = tempPath("hostile.md");
  writeFileSync(
    path,
    Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.alloc(256, 0xff)]),
  );

  await expect(detectEither(path)).resolves.toMatchObject({
    _tag: "Left",
    left: { _tag: "UNSUPPORTED_SOURCE_FILE_TYPE" },
  });
});
