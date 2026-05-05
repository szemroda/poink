/**
 * Office document extraction service.
 *
 * Supports DOCX via mammoth and OpenDocument text files via ODF XML.
 */

import { Context, Effect, Layer, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import mammoth from "mammoth";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { resolveUserPath } from "../pathUtils.js";
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
  getAttribute?: (name: string) => string | null;
};

type XmlDocument = {
  getElementsByTagName: (name: string) => ArrayLike<unknown>;
};

const XML_ELEMENT_NODE = 1;
const XML_TEXT_NODE = 3;
const XML_CDATA_NODE = 4;
const XML_DOCUMENT_NODE = 9;

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

async function extractDocx(path: string): Promise<ExtractedOfficeDocument> {
  const result = await mammoth.extractRawText({ path });
  const sections = sectionsFromPlainText(result.value);
  return {
    fileType: "docx",
    sections,
    sectionCount: sections.length,
  };
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

function directElementsByLocalName(
  root: XmlDocument,
  names: Set<string>,
): XmlNode[] {
  const elements = Array.from(
    root.getElementsByTagName("*"),
  ) as unknown as XmlNode[];
  return elements.filter((element) => names.has(localName(element)));
}

function sectionsFromOdfXml(xml: string): ExtractedOfficeSection[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  const bodyElements = directElementsByLocalName(doc, new Set(["h", "p"]));
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

  for (const element of bodyElements) {
    const name = localName(element);
    const text = sanitizeText(extractNodeText(element))
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!text) continue;

    if (name === "h") {
      flush();
      currentHeading = text;
    } else {
      currentParagraphs.push(text);
    }
  }

  flush();
  return sections;
}

async function extractOdt(path: string): Promise<ExtractedOfficeDocument> {
  const ext = extname(path).toLowerCase();
  const xml =
    ext === ".fodt"
      ? readFileSync(path, "utf-8")
      : await (async () => {
          const zip = await JSZip.loadAsync(await Bun.file(path).bytes());
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
