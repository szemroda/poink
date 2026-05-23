import { Effect } from "effect";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { basename, extname, join } from "node:path";
import { URLFetchError } from "./index.js";
import {
  Config,
  DEFAULT_URL_DOWNLOAD_MAX_FILE_SIZE,
  DEFAULT_URL_DOWNLOAD_MAX_REDIRECTS,
  DEFAULT_URL_DOWNLOAD_TIMEOUT,
  type DocumentFileType,
} from "./types.js";
import { writeFileData } from "./runtime.js";

const MARKDOWN_PEEK_SIZE = 4096;

type URLDownloadOptions = {
  maxFileSize: string;
  timeout: string;
  maxRedirects: number;
  allowPrivateNetwork: boolean;
  allowedPrivateNetworkHosts: string[];
};

export type ResolvedURLDownloadOptions = URLDownloadOptions & {
  maxFileSizeBytes: number;
  timeoutMs: number;
};

export type DNSLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

type NodeLookup = LookupFunction;

type CLIErrorFactory = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => Error;

export const DEFAULT_URL_DOWNLOAD_OPTIONS: URLDownloadOptions = {
  maxFileSize: DEFAULT_URL_DOWNLOAD_MAX_FILE_SIZE,
  timeout: DEFAULT_URL_DOWNLOAD_TIMEOUT,
  maxRedirects: DEFAULT_URL_DOWNLOAD_MAX_REDIRECTS,
  allowPrivateNetwork: false,
  allowedPrivateNetworkHosts: [],
};

const PRIVATE_NETWORK_BLOCK_LIST = new BlockList();
for (const [address, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
] as const) {
  PRIVATE_NETWORK_BLOCK_LIST.addSubnet(address, prefix, type);
}

export const MARKDOWN_INDICATORS = [
  /^#{1,6}\s/m,
  /^[-*+]\s/m,
  /^\d+\.\s/m,
  /^```/m,
  /^\|.+\|/m,
  /\[.+\]\(.+\)/m,
];

const SUPPORTED_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".md",
  ".markdown",
  ".docx",
  ".odt",
  ".fodt",
] as const;

export function fileTypeFromExtension(ext: string): DocumentFileType | null {
  switch (ext.toLowerCase()) {
    case ".pdf":
      return "pdf";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".docx":
      return "docx";
    case ".odt":
    case ".fodt":
      return "odt";
    default:
      return null;
  }
}

function isSupportedDocumentPath(path: string): boolean {
  return fileTypeFromExtension(extname(path)) !== null;
}

export function filenameFromURL(url: string): string {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  const name = basename(pathname);
  if (name && isSupportedDocumentPath(name)) {
    return name;
  }

  return `${name}.pdf`;
}

function stripRecognizedDocumentExtension(filename: string): string {
  return filename.replace(/\.(pdf|md|markdown|docx|odt|fodt)$/i, "");
}

function extensionForDetectedType(
  fileType: DocumentFileType,
  sourceName: string,
): string {
  if (fileType === "pdf") return ".pdf";
  if (fileType === "markdown") {
    const ext = extname(sourceName).toLowerCase();
    return ext === ".markdown" ? ".markdown" : ".md";
  }
  if (fileType === "docx") return ".docx";
  return extname(sourceName).toLowerCase() === ".fodt" ? ".fodt" : ".odt";
}

export function getDownloadTargetPath(
  url: string,
  downloadsDir: string,
  fileType: DocumentFileType,
): string {
  const sourceFilename = filenameFromURL(url);
  const basenameWithoutExt =
    stripRecognizedDocumentExtension(sourceFilename) || "download";
  const finalExtension = extensionForDetectedType(fileType, sourceFilename);
  return join(downloadsDir, `${basenameWithoutExt}${finalExtension}`);
}

export function looksLikeMarkdown(content: string): boolean {
  return MARKDOWN_INDICATORS.some((pattern) => pattern.test(content));
}

export function hasMarkdownExtension(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname).toLowerCase();
    return ext === ".md" || ext === ".markdown";
  } catch {
    return url.endsWith(".md") || url.endsWith(".markdown");
  }
}

function hasPdfExtension(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return extname(pathname).toLowerCase() === ".pdf";
  } catch {
    return url.toLowerCase().endsWith(".pdf");
  }
}

function fileTypeFromURLExtension(url: string): DocumentFileType | null {
  try {
    const pathname = new URL(url).pathname;
    return fileTypeFromExtension(extname(pathname));
  } catch {
    const lower = url.toLowerCase();
    const match = SUPPORTED_DOCUMENT_EXTENSIONS.find((ext) =>
      lower.endsWith(ext),
    );
    return match ? fileTypeFromExtension(match) : null;
  }
}

function normalizeURLHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  return withoutBrackets.endsWith(".")
    ? withoutBrackets.slice(0, -1)
    : withoutBrackets;
}

function ipv4FromMappedIPv6(address: string): string | null {
  const normalized = normalizeURLHostname(address);
  if (!normalized.startsWith("::ffff:")) return null;

  const mapped = normalized.slice("::ffff:".length);
  if (isIP(mapped) === 4) return mapped;

  const parts = mapped.split(":");
  if (parts.length !== 2) return null;

  const words = parts.map((part) => Number.parseInt(part, 16));
  if (
    words.some(
      (word, index) =>
        !/^[0-9a-f]{1,4}$/i.test(parts[index]) ||
        !Number.isInteger(word) ||
        word < 0 ||
        word > 0xffff,
    )
  ) {
    return null;
  }

  return [
    words[0] >> 8,
    words[0] & 0xff,
    words[1] >> 8,
    words[1] & 0xff,
  ].join(".");
}

export function parseSizeString(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i);
  if (!match) {
    throw new Error(
      "Expected size with a unit suffix, such as 500kb, 100mb, or 1gb",
    );
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "b"
      ? 1
      : unit === "kb"
        ? 1024
        : unit === "mb"
          ? 1024 * 1024
          : 1024 * 1024 * 1024;
  const bytes = Math.floor(amount * multiplier);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`Invalid size value: ${value}`);
  }
  return bytes;
}

export function parseDurationString(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)$/i);
  if (!match) {
    throw new Error(
      "Expected duration with a unit suffix, such as 500ms, 30s, or 2m",
    );
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : 60_000;
  const milliseconds = Math.floor(amount * multiplier);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error(`Invalid duration value: ${value}`);
  }
  return milliseconds;
}

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = normalizeURLHostname(address);
  const version = isIP(normalized);
  if (version === 0) return false;

  if (version === 6) {
    const mappedIPv4 = ipv4FromMappedIPv6(normalized);
    if (mappedIPv4) {
      return PRIVATE_NETWORK_BLOCK_LIST.check(mappedIPv4, "ipv4");
    }
  }

  return PRIVATE_NETWORK_BLOCK_LIST.check(
    normalized,
    version === 4 ? "ipv4" : "ipv6",
  );
}

export function parseStringList(
  value: string | boolean | undefined,
): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => typeof item === "string")
    ) {
      throw new Error("Expected a JSON array of strings");
    }
    return parsed;
  }

  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function resolveURLDownloadOptions(
  config: Config,
  opts: Record<string, string | boolean>,
  createCLIError: CLIErrorFactory = (_code, message) => new Error(message),
): ResolvedURLDownloadOptions {
  const configured = config.ingest.urlDownloads;
  const maxFileSize =
    typeof opts["max-file-size"] === "string"
      ? opts["max-file-size"]
      : configured.maxFileSize;
  const timeout =
    typeof opts["download-timeout"] === "string"
      ? opts["download-timeout"]
      : configured.timeout;
  const maxRedirects =
    typeof opts["max-redirects"] === "string"
      ? Number(opts["max-redirects"])
      : configured.maxRedirects;
  const allowedPrivateNetworkHosts =
    parseStringList(opts["allowed-private-network-hosts"]) ??
    Array.from(configured.allowedPrivateNetworkHosts);

  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw createCLIError(
      "INVALID_ARGS",
      "Invalid --max-redirects value (expected a non-negative integer)",
      { flag: "--max-redirects", value: opts["max-redirects"] },
    );
  }

  try {
    return {
      maxFileSize,
      timeout,
      maxRedirects,
      allowPrivateNetwork:
        opts["allow-private-network"] === true ||
        configured.allowPrivateNetwork,
      allowedPrivateNetworkHosts,
      maxFileSizeBytes: parseSizeString(maxFileSize),
      timeoutMs: parseDurationString(timeout),
    };
  } catch (error) {
    throw createCLIError(
      "INVALID_ARGS",
      `Invalid URL download option: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { maxFileSize, timeout },
    );
  }
}

function hostAllowsPrivateNetwork(
  hostname: string,
  options: ResolvedURLDownloadOptions,
): boolean {
  const normalized = normalizeURLHostname(hostname);
  return options.allowedPrivateNetworkHosts
    .map(normalizeURLHostname)
    .includes(normalized);
}

async function resolveDownloadAddresses(
  hostname: string,
  options: ResolvedURLDownloadOptions,
  lookup: DNSLookup,
): Promise<Array<{ address: string; family: number }>> {
  const normalized = normalizeURLHostname(hostname);
  if (!normalized) throw new Error("URL host is required");

  const addresses = isIP(normalized)
    ? [{ address: normalized, family: isIP(normalized) }]
    : await lookup(normalized, { all: true, verbatim: true });

  if (options.allowPrivateNetwork || hostAllowsPrivateNetwork(normalized, options)) {
    return addresses;
  }

  const blocked = addresses.find((entry) =>
    isPrivateNetworkAddress(entry.address),
  );
  if (blocked) {
    throw new Error(
      `Blocked private or reserved network address for ${normalized}: ${blocked.address}`,
    );
  }

  return addresses;
}

export async function assertURLDownloadAllowed(
  url: URL,
  options: ResolvedURLDownloadOptions,
  lookup: DNSLookup = dnsLookup,
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }

  await resolveDownloadAddresses(url.hostname, options, lookup);
}

function makeGuardedLookup(options: ResolvedURLDownloadOptions): NodeLookup {
  return (hostname, _lookupOptions, callback) => {
    void (async () => {
      try {
        const addresses = await resolveDownloadAddresses(
          hostname,
          options,
          dnsLookup,
        );
        const first = addresses[0];
        if (!first) {
          throw new Error(`No addresses found for ${normalizeURLHostname(hostname)}`);
        }
        callback(null, first.address, first.family);
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          "",
          4,
        );
      }
    })();
  };
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function headerValue(value: string | string[] | number | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value === undefined ? "" : String(value);
}

function closeIncomingMessage(response: IncomingMessage): void {
  if (!response.destroyed) {
    response.destroy();
  }
}

function throwAfterClosingResponse(
  response: IncomingMessage,
  error: Error,
): never {
  closeIncomingMessage(response);
  throw error;
}

async function requestURLWithGuards(
  url: string,
  options: ResolvedURLDownloadOptions,
  signal: AbortSignal,
  userAgent: string,
): Promise<IncomingMessage> {
  let current = new URL(url);

  for (let redirectCount = 0; ; redirectCount++) {
    await assertURLDownloadAllowed(current, options);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const requester = current.protocol === "https:" ? httpsRequest : httpRequest;
      const request = requester(
        current,
        {
          method: "GET",
          headers: { "user-agent": userAgent },
          lookup: makeGuardedLookup(options),
          signal,
        },
        resolve,
      );
      request.once("error", reject);
      request.end();
    });

    if (!isRedirectStatus(response.statusCode ?? 0)) {
      return response;
    }

    if (redirectCount >= options.maxRedirects) {
      throwAfterClosingResponse(
        response,
        new Error(`Too many redirects (max ${options.maxRedirects})`),
      );
    }

    const location = headerValue(response.headers.location);
    if (!location) {
      throwAfterClosingResponse(
        response,
        new Error(
          `Redirect HTTP ${response.statusCode ?? 0} missing Location header`,
        ),
      );
    }
    closeIncomingMessage(response);
    current = new URL(location, current);
  }
}

export async function readStreamWithLimit(
  chunks: AsyncIterable<Uint8Array | Buffer | string>,
  maxBytes: number,
  onExceeded?: () => void,
): Promise<ArrayBuffer> {
  const collected: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of chunks) {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      onExceeded?.();
      throw new Error(`Download exceeds max file size (${maxBytes} bytes)`);
    }
    collected.push(bytes);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of collected) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

function assertContentLengthWithinLimit(
  contentLength: string,
  maxBytes: number,
  onExceeded?: () => void,
): void {
  const parsedLength = Number(contentLength);
  if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
    onExceeded?.();
    throw new Error(
      `Download exceeds max file size (${contentLength} bytes > ${maxBytes} bytes)`,
    );
  }
}

async function readIncomingMessageWithLimit(
  response: IncomingMessage,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const contentLength = headerValue(response.headers["content-length"]);
  if (contentLength) {
    assertContentLengthWithinLimit(contentLength, maxBytes, () =>
      response.destroy(),
    );
  }

  return readStreamWithLimit(response, maxBytes, () => response.destroy());
}

export async function readResponseBufferWithLimit(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    assertContentLengthWithinLimit(contentLength, maxBytes);
  }

  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const stream = {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };

  return readStreamWithLimit(stream, maxBytes);
}

function detectDocumentTypeFromHeaders(
  url: string,
  contentType: string,
): {
  detectedFileType: DocumentFileType | null;
  hasTextPlainMime: boolean;
} {
  const hasExplicitMarkdownMime =
    contentType.includes("text/markdown") ||
    contentType.includes("text/x-markdown");
  const hasMarkdownExt = hasMarkdownExtension(url);
  const hasPdfExt = hasPdfExtension(url);
  const hasTextPlainMime = contentType.includes("text/plain");
  const hasTextXmlMime =
    contentType.includes("text/xml") || contentType.includes("application/xml");
  const hasTextualMime =
    hasExplicitMarkdownMime || hasTextPlainMime || hasTextXmlMime;
  const extensionFileType = fileTypeFromURLExtension(url);

  if (contentType.includes("pdf") || (hasPdfExt && !hasTextualMime)) {
    return { detectedFileType: "pdf", hasTextPlainMime };
  }

  if (hasExplicitMarkdownMime || hasMarkdownExt) {
    return { detectedFileType: "markdown", hasTextPlainMime };
  }

  if (
    contentType.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ) ||
    (extensionFileType === "docx" && !hasTextualMime)
  ) {
    return { detectedFileType: "docx", hasTextPlainMime };
  }

  if (
    contentType.includes("application/vnd.oasis.opendocument.text") ||
    (extensionFileType === "odt" && (!hasTextPlainMime || hasTextXmlMime))
  ) {
    return { detectedFileType: "odt", hasTextPlainMime };
  }

  return { detectedFileType: null, hasTextPlainMime };
}

function detectTextPlainDocumentType(
  buffer: ArrayBuffer,
): DocumentFileType | null {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const preview = decoder.decode(buffer.slice(0, MARKDOWN_PEEK_SIZE));
  return looksLikeMarkdown(preview) ? "markdown" : null;
}

export function downloadFile(
  url: string,
  downloadsDir: string,
  options: ResolvedURLDownloadOptions,
  userAgent: string,
) {
  return Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

      try {
        const response = await requestURLWithGuards(
          url,
          options,
          controller.signal,
          userAgent,
        );
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          throwAfterClosingResponse(
            response,
            new Error(`HTTP ${statusCode}: ${response.statusMessage ?? ""}`),
          );
        }

        const contentType = headerValue(response.headers["content-type"]);
        const initialDetection = detectDocumentTypeFromHeaders(url, contentType);

        if (
          !initialDetection.detectedFileType &&
          initialDetection.hasTextPlainMime
        ) {
          const buffer = await readIncomingMessageWithLimit(
            response,
            options.maxFileSizeBytes,
          );
          const textPlainType = detectTextPlainDocumentType(buffer);
          if (!textPlainType) {
            throw new Error(`Unsupported content type: ${contentType}`);
          }
          const finalPath = getDownloadTargetPath(url, downloadsDir, textPlainType);
          await writeFileData(finalPath, buffer);
          return finalPath;
        }

        const detectedFileType = initialDetection.detectedFileType;
        if (!detectedFileType) {
          throwAfterClosingResponse(
            response,
            new Error(`Unsupported content type: ${contentType}`),
          );
        }

        const finalPath = getDownloadTargetPath(
          url,
          downloadsDir,
          detectedFileType,
        );
        const buffer = await readIncomingMessageWithLimit(
          response,
          options.maxFileSizeBytes,
        );
        await writeFileData(finalPath, buffer);
        return finalPath;
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "AbortError" || controller.signal.aborted)
        ) {
          throw new Error(`Download timed out after ${options.timeout}`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    catch: (e) => new URLFetchError({ url, reason: String(e) }),
  });
}
