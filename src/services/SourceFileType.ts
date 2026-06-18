import { Context, Effect, Layer } from "effect";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import {
  fileTypeFromFile,
  type FileTypeResult,
} from "file-type";
import { MAX_ODT_XML_BYTES } from "./SourceFileLimits.js";

export type SourceFormat =
  | "pdf"
  | "markdown-text"
  | "docx-package"
  | "odt-package"
  | "odt-flat-xml";

export type DetectedSourceType =
  | { sourceFormat: "pdf"; fileType: "pdf" }
  | { sourceFormat: "markdown-text"; fileType: "markdown" }
  | { sourceFormat: "docx-package"; fileType: "docx" }
  | {
      sourceFormat: "odt-package" | "odt-flat-xml";
      fileType: "odt";
    };

export type OfficeSourceFormat = Extract<
  SourceFormat,
  "docx-package" | "odt-package" | "odt-flat-xml"
>;

export type OfficeDetectedSourceType = Extract<
  DetectedSourceType,
  { sourceFormat: OfficeSourceFormat }
>;

export class UnsupportedSourceFileTypeError extends Error {
  readonly _tag = "UNSUPPORTED_SOURCE_FILE_TYPE";

  constructor() {
    super("Source content is a known unsupported file type");
  }
}

export class SourceFileTypeUndeterminedError extends Error {
  readonly _tag = "SOURCE_FILE_TYPE_UNDETERMINED";

  constructor() {
    super("Source file type could not be determined safely");
  }
}

type DetectionError =
  | UnsupportedSourceFileTypeError
  | SourceFileTypeUndeterminedError;

type PrimaryBinaryDetector = (
  path: string,
) => Promise<FileTypeResult | undefined>;

type BinaryDetection =
  | { kind: "none" }
  | { kind: "generic-xml" }
  | { kind: "supported"; detected: DetectedSourceType };

type SourceProbe = {
  fileSize: number;
  prefix: Uint8Array;
};

const SOURCE_TYPES = {
  pdf: { sourceFormat: "pdf", fileType: "pdf" },
  markdown: { sourceFormat: "markdown-text", fileType: "markdown" },
  docx: { sourceFormat: "docx-package", fileType: "docx" },
  odtPackage: { sourceFormat: "odt-package", fileType: "odt" },
  odtFlatXml: { sourceFormat: "odt-flat-xml", fileType: "odt" },
} as const satisfies Readonly<Record<string, DetectedSourceType>>;

const PDF_HEADER_LIMIT = 1024;
const PDF_HEADER_MAX_BYTES = 10;
const PDF_PROBE_BYTES = PDF_HEADER_LIMIT + PDF_HEADER_MAX_BYTES;
const PDF_HEADER_PATTERN = /%PDF-(?:1\.[0-7]|2\.0)(?=\r\n|\r|\n)/g;
const ODF_TEXT_MIME = "application/vnd.oasis.opendocument.text";
const OFFICE_NAMESPACE =
  "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

function supportedBinaryType(
  extension: string,
  mime: string,
): DetectedSourceType | null {
  if (extension === "pdf" && mime === "application/pdf") {
    return { ...SOURCE_TYPES.pdf };
  }
  if (
    extension === "docx" &&
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return { ...SOURCE_TYPES.docx };
  }
  if (extension === "odt" && mime === ODF_TEXT_MIME) {
    return { ...SOURCE_TYPES.odtPackage };
  }
  return null;
}

function classifyBinaryDetection(
  detected: FileTypeResult | undefined,
): BinaryDetection {
  if (!detected) return { kind: "none" };

  const genericXml =
    detected.ext === "xml" &&
    (detected.mime === "application/xml" || detected.mime === "text/xml");
  if (genericXml) return { kind: "generic-xml" };

  const supported = supportedBinaryType(detected.ext, detected.mime);
  if (!supported) {
    throw new UnsupportedSourceFileTypeError();
  }
  return { kind: "supported", detected: supported };
}

export function isOfficeDetectedSourceType(
  detected: DetectedSourceType,
): detected is OfficeDetectedSourceType {
  return (
    detected.sourceFormat === "docx-package" ||
    detected.sourceFormat === "odt-package" ||
    detected.sourceFormat === "odt-flat-xml"
  );
}

async function readPrefix(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function probeSource(path: string): Promise<SourceProbe> {
  const sourceStat = await stat(path);
  const prefix = await readPrefix(path, PDF_PROBE_BYTES);
  return { fileSize: sourceStat.size, prefix };
}

function hasCompatiblePdfHeader(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString("latin1");
  for (const match of text.matchAll(PDF_HEADER_PATTERN)) {
    if ((match.index ?? PDF_HEADER_LIMIT) < PDF_HEADER_LIMIT) return true;
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

type FlatOdtInspection = "match" | "no-match" | "failure";

function inspectFlatOdtXml(text: string): FlatOdtInspection {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("<")) return "no-match";

  let malformed = false;
  const parser = new DOMParser({
    onError: (level) => {
      if (level !== "warning") {
        malformed = true;
      }
    },
  });
  let document;
  try {
    document = parser.parseFromString(text, "application/xml");
  } catch {
    return "failure";
  }
  if (malformed) return "failure";

  const root = document.documentElement;
  if (!root || root.namespaceURI !== OFFICE_NAMESPACE) return "no-match";
  if (root.localName !== "document") return "no-match";
  if (
    root.getAttributeNS(OFFICE_NAMESPACE, "mimetype") !== ODF_TEXT_MIME &&
    root.getAttribute("office:mimetype") !== ODF_TEXT_MIME
  ) {
    return "no-match";
  }

  const bodies = document.getElementsByTagNameNS(OFFICE_NAMESPACE, "body");
  const texts = document.getElementsByTagNameNS(OFFICE_NAMESPACE, "text");
  return bodies.length === 1 && texts.length === 1 ? "match" : "no-match";
}

type Utf8FileInspection = {
  valid: boolean;
  firstSignificantCharacter?: string;
};

function firstSignificantCharacter(text: string): string | undefined {
  return text.match(/[^\s\uFEFF]/u)?.[0];
}

async function inspectUtf8File(path: string): Promise<Utf8FileInspection> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let firstCharacter: string | undefined;
  const inspectText = (text: string) => {
    if (firstCharacter !== undefined) return;
    firstCharacter = firstSignificantCharacter(text);
  };

  try {
    for await (const chunk of createReadStream(path)) {
      inspectText(decoder.decode(chunk, { stream: true }));
    }
    inspectText(decoder.decode());
    return { valid: true, firstSignificantCharacter: firstCharacter };
  } catch {
    return { valid: false };
  }
}

async function detectLargeTextFallback(
  path: string,
  markdownExtension: boolean,
): Promise<DetectedSourceType> {
  if (markdownExtension) {
    const utf8 = await inspectUtf8File(path);
    if (utf8.valid && utf8.firstSignificantCharacter !== "<") {
      return { ...SOURCE_TYPES.markdown };
    }
  }
  throw new SourceFileTypeUndeterminedError();
}

function detectBoundedTextFallback(
  text: string | null,
  binary: BinaryDetection,
  markdownExtension: boolean,
): DetectedSourceType {
  if (text !== null && text.trimStart().startsWith("<")) {
    const flatOdt = inspectFlatOdtXml(text);
    if (flatOdt === "match") {
      return { ...SOURCE_TYPES.odtFlatXml };
    }
    if (flatOdt === "failure") {
      throw new SourceFileTypeUndeterminedError();
    }
  }

  if (binary.kind === "generic-xml") {
    throw new UnsupportedSourceFileTypeError();
  }
  if (markdownExtension && text !== null) {
    return { ...SOURCE_TYPES.markdown };
  }
  throw new SourceFileTypeUndeterminedError();
}

async function resolveOrUndetermined<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new SourceFileTypeUndeterminedError();
  }
}

async function detectSourceFileType(
  path: string,
  detectBinary: PrimaryBinaryDetector,
): Promise<DetectedSourceType> {
  const detectedBinary = await resolveOrUndetermined(() => detectBinary(path));
  const binary = classifyBinaryDetection(detectedBinary);
  if (binary.kind === "supported") return binary.detected;

  const probe = await resolveOrUndetermined(() => probeSource(path));
  if (hasCompatiblePdfHeader(probe.prefix)) {
    return { ...SOURCE_TYPES.pdf };
  }

  const extension = extname(path).toLowerCase();
  const markdownExtension = MARKDOWN_EXTENSIONS.has(extension);

  if (probe.fileSize > MAX_ODT_XML_BYTES) {
    return detectLargeTextFallback(path, markdownExtension);
  }

  const text = await resolveOrUndetermined(async () =>
    decodeUtf8(await readFile(path)),
  );
  return detectBoundedTextFallback(text, binary, markdownExtension);
}

function hasErrorTag(error: unknown): error is { _tag: unknown } {
  return typeof error === "object" && error !== null && "_tag" in error;
}

function normalizeDetectionError(error: unknown): DetectionError {
  if (!hasErrorTag(error)) {
    return new SourceFileTypeUndeterminedError();
  }
  if (error._tag === "UNSUPPORTED_SOURCE_FILE_TYPE") {
    return new UnsupportedSourceFileTypeError();
  }
  return new SourceFileTypeUndeterminedError();
}

export class SourceFileTypeDetector extends Context.Tag(
  "SourceFileTypeDetector",
)<
  SourceFileTypeDetector,
  {
    readonly detect: (
      path: string,
    ) => Effect.Effect<DetectedSourceType, DetectionError>;
  }
>() {}

export function makeSourceFileTypeDetector(
  detectBinary: PrimaryBinaryDetector = fileTypeFromFile,
) {
  return Layer.succeed(SourceFileTypeDetector, {
    detect: (path) =>
      Effect.tryPromise({
        try: () => detectSourceFileType(path, detectBinary),
        catch: normalizeDetectionError,
      }),
  });
}

export const SourceFileTypeDetectorLive = makeSourceFileTypeDetector();
