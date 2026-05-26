/**
 * Office document extraction service.
 *
 * Supports DOCX via mammoth and OpenDocument text files via ODF XML.
 */

import { Context, Effect, Layer, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Readable } from "node:stream";
import mammoth from "mammoth";
import JSZip from "jszip";
import * as yauzl from "yauzl";
import { DOMParser } from "@xmldom/xmldom";
import { resolveUserPath } from "../pathUtils.js";
import { readFileBytes } from "../runtime.js";
import { LibraryConfig, type DocumentFileType } from "../types.js";
import { chunkText, sanitizeText } from "./PDFExtractor.js";

// ============================================================================
// Custom Error Types
// ============================================================================

export class OfficeNotFoundError extends Schema.TaggedError<OfficeNotFoundError>()(
  "OfficeNotFoundError",
  { path: Schema.String },
) {}

export class OfficeExtractionError extends Schema.TaggedError<OfficeExtractionError>()(
  "OfficeExtractionError",
  { path: Schema.String, reason: Schema.String },
) {}

// ============================================================================
// Types
// ============================================================================

export interface ExtractedOfficeSection {
  section: number;
  heading: string;
  text: string;
}

export interface ExtractedOfficeDocument {
  fileType: Extract<DocumentFileType, "docx" | "odt">;
  sections: ExtractedOfficeSection[];
  sectionCount: number;
}

export interface ProcessedChunk {
  page: number;
  chunkIndex: number;
  content: string;
}

type XmlNode = {
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string | null;
  firstChild: XmlNode | null;
  nextSibling: XmlNode | null;
  parentNode?: XmlNode | null;
  getAttribute?: (name: string) => string | null;
};

type XmlDocument = {
  getElementsByTagName: (name: string) => ArrayLike<unknown>;
};

const XML_ELEMENT_NODE = 1;
const XML_TEXT_NODE = 3;
const XML_CDATA_NODE = 4;
const XML_DOCUMENT_NODE = 9;

const HTML_BLOCK_NAMES = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "table",
]);
const ODF_BLOCK_NAMES = new Set(["h", "p", "table"]);
const TABLE_ROW_NAMES = new Set(["tr", "table-row"]);
const TABLE_CELL_NAMES = new Set(["td", "th", "table-cell"]);
const TABLE_NAMES = new Set(["table"]);
const HTML_HEADING_RE = /^h[1-6]$/;

const MAX_OFFICE_PACKAGE_BYTES = 200 * 1024 * 1024;
const MAX_OFFICE_ZIP_ENTRIES = 10_000;
const MAX_OFFICE_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_OFFICE_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_OFFICE_XML_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_ODT_CONTENT_XML_BYTES = 20 * 1024 * 1024;
const SAFE_ZIP_READ_OPTIONS = {
  lazyEntries: true,
  validateEntrySizes: true,
} as const;

type ZipEntryInfo = {
  name: string;
  uncompressedSize: number;
};

type ZipValidationOptions = {
  contentXml?: boolean;
};

// ============================================================================
// Service Definition
// ============================================================================

export class OfficeExtractor extends Context.Tag("OfficeExtractor")<
  OfficeExtractor,
  {
    readonly extract: (
      path: string,
    ) => Effect.Effect<
      ExtractedOfficeDocument,
      OfficeExtractionError | OfficeNotFoundError
    >;
    readonly process: (
      path: string,
    ) => Effect.Effect<
      { pageCount: number; chunks: ProcessedChunk[] },
      OfficeExtractionError | OfficeNotFoundError
    >;
  }
>() {}

// ============================================================================
// Implementation
// ============================================================================

function resolvePath(path: string): string {
  return resolveUserPath(path);
}

function officeFileTypeForPath(
  path: string,
): Extract<DocumentFileType, "docx" | "odt"> {
  const ext = extname(path).toLowerCase();
  if (ext === ".docx") return "docx";
  if (ext === ".odt" || ext === ".fodt") return "odt";
  throw new Error(`Unsupported office document extension: ${ext || "(none)"}`);
}

function sectionsFromPlainText(text: string): ExtractedOfficeSection[] {
  const cleaned = sanitizeText(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!cleaned) return [];
  return [{ section: 1, heading: "", text: cleaned }];
}

function assertWithinLimit(
  value: number,
  limit: number,
  description: string,
): void {
  if (value > limit) {
    throw new Error(
      `${description} exceeds limit (${value} bytes > ${limit} bytes)`,
    );
  }
}

async function assertSafeOfficePackageFile(path: string): Promise<void> {
  const file = await stat(path);
  assertWithinLimit(
    file.size,
    MAX_OFFICE_PACKAGE_BYTES,
    "Office package size",
  );
}

function openZipFromBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, SAFE_ZIP_READ_OPTIONS, (error, zipfile) => {
      if (error) {
        reject(error);
      } else if (!zipfile) {
        reject(new Error("Unable to open Office ZIP package"));
      } else {
        resolve(zipfile);
      }
    });
  });
}

function zipEntryInfo(entry: yauzl.Entry): ZipEntryInfo {
  return {
    name: entry.fileName.replace(/\\/g, "/"),
    uncompressedSize: entry.uncompressedSize,
  };
}

function entryLimit(
  entry: ZipEntryInfo,
  options: ZipValidationOptions,
  sizeKind: "declared" | "actual",
): { limit: number; description: string } {
  if (options.contentXml && entry.name === "content.xml") {
    return {
      limit: MAX_ODT_CONTENT_XML_BYTES,
      description: `ODF content.xml ${sizeKind} uncompressed size`,
    };
  }

  if (entry.name.toLowerCase().endsWith(".xml")) {
    return {
      limit: MAX_OFFICE_XML_ENTRY_UNCOMPRESSED_BYTES,
      description: `Office ZIP XML entry ${entry.name} ${sizeKind} uncompressed size`,
    };
  }

  return {
    limit: MAX_OFFICE_ENTRY_UNCOMPRESSED_BYTES,
    description: `Office ZIP entry ${entry.name} ${sizeKind} uncompressed size`,
  };
}

function assertDeclaredZipEntry(
  entry: ZipEntryInfo,
  options: ZipValidationOptions,
  onBytes: (bytes: number) => void,
): void {
  const limit = entryLimit(entry, options, "declared");

  onBytes(entry.uncompressedSize);
  assertWithinLimit(
    entry.uncompressedSize,
    limit.limit,
    limit.description,
  );
}

function assertTotalUncompressedSize(bytes: number, sizeKind: string): void {
  assertWithinLimit(
    bytes,
    MAX_OFFICE_TOTAL_UNCOMPRESSED_BYTES,
    `Office package ${sizeKind} uncompressed size`,
  );
}

function openZipEntryStream(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  name: string,
): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read Office ZIP entry ${name}`));
      } else {
        resolve(stream);
      }
    });
  });
}

async function validateZipEntryStream(
  zipfile: yauzl.ZipFile,
  rawEntry: yauzl.Entry,
  entry: ZipEntryInfo,
  options: ZipValidationOptions,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const limit = entryLimit(entry, options, "actual");
  const stream = await openZipEntryStream(zipfile, rawEntry, entry.name);

  return new Promise((resolve, reject) => {
    let entryBytes = 0;

    stream.on("data", (chunk: Buffer) => {
      try {
        entryBytes += chunk.byteLength;
        assertWithinLimit(entryBytes, limit.limit, limit.description);
        onBytes(chunk.byteLength);
      } catch (limitError) {
        stream.destroy(limitError as Error);
      }
    });
    stream.on("error", (streamError) => {
      reject(
        new Error(
          `Office ZIP entry ${entry.name} failed validation: ${String(
            streamError,
          )}`,
        ),
      );
    });
    stream.on("end", resolve);
  });
}

function validateZipEntries(
  zipfile: yauzl.ZipFile,
  options: ZipValidationOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let foundContentXml = false;
    let declaredUncompressed = 0;
    let actualUncompressed = 0;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    zipfile.on("entry", (rawEntry: yauzl.Entry) => {
      const entry = zipEntryInfo(rawEntry);
      if (entry.name.endsWith("/")) {
        zipfile.readEntry();
        return;
      }

      foundContentXml ||= entry.name === "content.xml";

      try {
        assertDeclaredZipEntry(entry, options, (bytes) => {
          declaredUncompressed += bytes;
          assertTotalUncompressedSize(declaredUncompressed, "declared");
        });
      } catch (error) {
        finish(() => reject(error));
        return;
      }

      validateZipEntryStream(zipfile, rawEntry, entry, options, (bytes) => {
        actualUncompressed += bytes;
        assertTotalUncompressedSize(actualUncompressed, "actual");
      }).then(
        () => zipfile.readEntry(),
        (error) => finish(() => reject(error)),
      );
    });

    zipfile.on("error", (error) => finish(() => reject(error)));
    zipfile.on("end", () => {
      finish(() => {
        if (options.contentXml && !foundContentXml) {
          reject(new Error("ODF package does not contain content.xml"));
        } else {
          resolve();
        }
      });
    });

    zipfile.readEntry();
  });
}

async function assertSafeOfficeZip(
  buffer: Buffer,
  options: ZipValidationOptions,
): Promise<void> {
  assertWithinLimit(
    buffer.byteLength,
    MAX_OFFICE_PACKAGE_BYTES,
    "Office package size",
  );

  const zipfile = await openZipFromBuffer(buffer);
  try {
    if (zipfile.entryCount > MAX_OFFICE_ZIP_ENTRIES) {
      throw new Error(
        `Office package contains too many ZIP entries (${zipfile.entryCount} > ${MAX_OFFICE_ZIP_ENTRIES})`,
      );
    }

    await validateZipEntries(zipfile, options);
  } finally {
    zipfile.close();
  }
}

function localName(node: XmlNode): string {
  return node.localName || node.nodeName.split(":").pop() || "";
}

function extractNodeText(node: XmlNode): string {
  if (node.nodeType === XML_TEXT_NODE || node.nodeType === XML_CDATA_NODE) {
    return node.nodeValue ?? "";
  }

  if (
    node.nodeType !== XML_ELEMENT_NODE &&
    node.nodeType !== XML_DOCUMENT_NODE
  ) {
    return "";
  }

  const name = localName(node);
  if (name === "s") {
    const rawCount = node.getAttribute?.("text:c") ?? node.getAttribute?.("c");
    const count = rawCount ? Number(rawCount) : 1;
    return " ".repeat(Number.isFinite(count) && count > 0 ? count : 1);
  }
  if (name === "tab") return "\t";
  if (name === "line-break" || name === "soft-page-break") return "\n";

  let text = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    text += extractNodeText(child);
  }
  return text;
}

function cleanExtractedText(text: string): string {
  return sanitizeText(text)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeTableCell(value: string): string {
  return cleanExtractedText(value).replace(/\|/g, "\\|");
}

function childElementsByLocalName(
  root: XmlNode,
  names: Set<string>,
): XmlNode[] {
  const elements: XmlNode[] = [];

  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === XML_ELEMENT_NODE && names.has(localName(child))) {
      elements.push(child);
    }
  }

  return elements;
}

function descendantElementsByLocalName(
  root: XmlNode,
  names: Set<string>,
): XmlNode[] {
  const elements: XmlNode[] = [];

  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== XML_ELEMENT_NODE) continue;
    if (names.has(localName(child))) elements.push(child);
    elements.push(...descendantElementsByLocalName(child, names));
  }

  return elements;
}

function renderOfficeTable(table: XmlNode): string {
  const rows = descendantElementsByLocalName(table, TABLE_ROW_NAMES)
    .map((row) =>
      childElementsByLocalName(row, TABLE_CELL_NAMES).map((cell) =>
        escapeTableCell(extractNodeText(cell)),
      ),
    )
    .filter((row) => row.some(Boolean));

  if (rows.length === 0) return "";

  const width = Math.max(...rows.map((row) => row.length));
  const paddedRows = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
  const separator = Array.from({ length: width }, () => "---");
  const renderRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

  return [
    renderRow(paddedRows[0] ?? []),
    renderRow(separator),
    ...paddedRows.slice(1).map(renderRow),
  ].join("\n");
}

function sectionsFromBlockElements(
  blockElements: XmlNode[],
  isHeading: (name: string) => boolean,
): ExtractedOfficeSection[] {
  const sections: ExtractedOfficeSection[] = [];

  let currentHeading = "";
  let currentParagraphs: string[] = [];

  const flush = () => {
    const text = currentParagraphs.join("\n\n").trim();
    if (!currentHeading && !text) return;
    sections.push({
      section: sections.length + 1,
      heading: currentHeading,
      text,
    });
    currentHeading = "";
    currentParagraphs = [];
  };

  for (const element of blockElements) {
    const name = localName(element);
    const text =
      name === "table"
        ? renderOfficeTable(element)
        : cleanExtractedText(extractNodeText(element));
    if (!text) continue;

    if (isHeading(name)) {
      flush();
      currentHeading = text;
    } else {
      currentParagraphs.push(text);
    }
  }

  flush();
  return sections;
}

function sectionsFromHtml(html: string): ExtractedOfficeSection[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<root>${html.replace(/&nbsp;/g, " ")}</root>`,
    "text/xml",
  );
  const blockElements = directElementsByLocalName(doc, HTML_BLOCK_NAMES);
  return sectionsFromBlockElements(blockElements, (name) =>
    HTML_HEADING_RE.test(name),
  );
}

async function extractDocx(path: string): Promise<ExtractedOfficeDocument> {
  await assertSafeOfficePackageFile(path);
  const buffer = Buffer.from(await readFileBytes(path));
  await assertSafeOfficeZip(buffer, { contentXml: false });

  const htmlResult = await mammoth.convertToHtml({ buffer });
  let sections = sectionsFromHtml(htmlResult.value);

  if (sections.length === 0) {
    const rawResult = await mammoth.extractRawText({ buffer });
    sections = sectionsFromPlainText(rawResult.value);
  }

  return {
    fileType: "docx",
    sections,
    sectionCount: sections.length,
  };
}

function directElementsByLocalName(
  root: XmlDocument,
  names: Set<string>,
): XmlNode[] {
  const elements = Array.from(
    root.getElementsByTagName("*"),
  ) as unknown as XmlNode[];
  return elements.filter(
    (element) =>
      names.has(localName(element)) &&
      !hasAncestorWithLocalName(element, TABLE_NAMES),
  );
}

function hasAncestorWithLocalName(element: XmlNode, names: Set<string>): boolean {
  for (let parent = element.parentNode; parent; parent = parent.parentNode) {
    if (names.has(localName(parent))) return true;
  }

  return false;
}

function sectionsFromOdfXml(xml: string): ExtractedOfficeSection[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  const bodyElements = directElementsByLocalName(doc, ODF_BLOCK_NAMES);
  return sectionsFromBlockElements(bodyElements, (name) => name === "h");
}

async function extractOdt(path: string): Promise<ExtractedOfficeDocument> {
  const ext = extname(path).toLowerCase();
  const xml =
    ext === ".fodt"
      ? readFileSync(path, "utf-8")
      : await (async () => {
          await assertSafeOfficePackageFile(path);
          const buffer = Buffer.from(await readFileBytes(path));
          await assertSafeOfficeZip(buffer, { contentXml: true });
          const zip = await JSZip.loadAsync(buffer);
          const contentXml = zip.file("content.xml");
          if (!contentXml) {
            throw new Error("ODF package does not contain content.xml");
          }
          return contentXml.async("string");
        })();

  const sections = sectionsFromOdfXml(xml);
  return {
    fileType: "odt",
    sections,
    sectionCount: sections.length,
  };
}

async function extractFromResolvedPath(
  path: string,
): Promise<ExtractedOfficeDocument> {
  const fileType = officeFileTypeForPath(path);
  return fileType === "docx" ? extractDocx(path) : extractOdt(path);
}

export const OfficeExtractorLive = Layer.effect(
  OfficeExtractor,
  Effect.gen(function* () {
    const config = LibraryConfig.fromEnv();

    return {
      extract: (path: string) =>
        Effect.gen(function* () {
          const resolvedPath = resolvePath(path);
          if (!existsSync(resolvedPath)) {
            return yield* Effect.fail(
              new OfficeNotFoundError({ path: resolvedPath }),
            );
          }

          return yield* Effect.tryPromise({
            try: async () => extractFromResolvedPath(resolvedPath),
            catch: (e) =>
              new OfficeExtractionError({
                path: resolvedPath,
                reason: String(e),
              }),
          });
        }),

      process: (path: string) =>
        Effect.gen(function* () {
          const resolvedPath = resolvePath(path);
          if (!existsSync(resolvedPath)) {
            return yield* Effect.fail(
              new OfficeNotFoundError({ path: resolvedPath }),
            );
          }

          const extracted = yield* Effect.tryPromise({
            try: async () => extractFromResolvedPath(resolvedPath),
            catch: (e) =>
              new OfficeExtractionError({
                path: resolvedPath,
                reason: String(e),
              }),
          });

          const allChunks: ProcessedChunk[] = [];
          for (const { section, heading, text } of extracted.sections) {
            const sectionContent = heading ? `${heading}\n\n${text}` : text;
            const sectionChunks = chunkText(
              sectionContent,
              config.chunkSize,
              config.chunkOverlap,
            );
            sectionChunks.forEach((content, chunkIndex) => {
              allChunks.push({ page: section, chunkIndex, content });
            });
          }

          return { pageCount: extracted.sectionCount, chunks: allChunks };
        }),
    };
  }),
);
