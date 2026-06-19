import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { expandHomePath, type Document } from "../types.js";
import {
  SourceFileChangedError,
  SourceFileUnavailableError,
  SourceFileUnreadableError,
  type SourceIdentity,
} from "./SourceIntegrity.js";

const EXPORT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const EXPORT_ID_LENGTH = 8;
const EXPORT_ID_ATTEMPTS = 32;
const RANDOM_BYTE_LIMIT =
  Math.floor(256 / EXPORT_ID_ALPHABET.length) * EXPORT_ID_ALPHABET.length;
const MANAGED_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type PageExportFormat = "pdf" | "png";

export type ParsedPageSelection = {
  readonly ranges: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
  }>;
};

export type PageExtractionOptions = {
  outputFormats: ReadonlySet<PageExportFormat>;
  outputDirectory?: string;
  pngWidth: number;
  cwd?: string;
};

export type PageExtractionResult = {
  exportId: string;
  docId: string;
  pages: number[];
  outputDirectory: string;
  files: string[];
};

export type PageExtractionErrorCode =
  | "INVALID_PAGE_SELECTOR"
  | "PAGE_OUT_OF_RANGE"
  | "INVALID_OUTPUT_FORMAT"
  | "INVALID_PNG_WIDTH"
  | "INVALID_FLAG_COMBINATION"
  | "OUTPUT_DIRECTORY_ERROR"
  | "OUTPUT_COLLISION"
  | "PDF_COPY_FAILED"
  | "PNG_RENDER_FAILED"
  | "PAGE_EXTRACTION_FAILED"
  | "SOURCE_METADATA_MISMATCH"
  | "INTERRUPTED";

export class PageExtractionError extends Error {
  constructor(
    readonly _tag: PageExtractionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type CleanupMode = "always" | "on-failure";
type FilesystemIdentity = {
  dev: bigint | number;
  ino: bigint | number;
};

class InvocationCleanup {
  private readonly paths = new Map<
    string,
    {
      mode: CleanupMode;
      identityPath?: string;
      identity?: FilesystemIdentity;
    }
  >();
  private cleanupPromise: Promise<void> | undefined;
  private publicationBarrier = Promise.resolve();
  private successful = false;
  private interrupted = false;

  readonly installSignalHandlers = (): (() => void) => {
    const onSignal = (signal: NodeJS.Signals) => {
      if (this.interrupted) return;
      this.interrupted = true;
      removeHandlers();
      void this.publicationBarrier
        .then(() => this.cleanup(false))
        .finally(() => {
          process.exit(signal === "SIGINT" ? 130 : 143);
        });
    };
    const removeHandlers = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    return removeHandlers;
  };

  track(
    path: string,
    mode: CleanupMode,
    options: {
      identityPath?: string;
      identity?: FilesystemIdentity;
    } = {},
  ): void {
    this.paths.set(path, { mode, ...options });
  }

  untrack(path: string): void {
    this.paths.delete(path);
  }

  markSuccessful(): void {
    this.successful = true;
  }

  wasInterrupted(): boolean {
    return this.interrupted;
  }

  async runPublicationCritical<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.publicationBarrier;
    let release: () => void = () => {};
    this.publicationBarrier = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    await previous;
    try {
      if (this.interrupted) {
        throw new PageExtractionError(
          "INTERRUPTED",
          "Page extraction was interrupted",
        );
      }
      return await operation();
    } finally {
      release();
    }
  }

  cleanup(includeSuccessfulOutputs = true): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      const entries = [...this.paths.entries()].reverse();
      for (const [path, tracked] of entries) {
        if (
          tracked.mode === "on-failure" &&
          this.successful &&
          includeSuccessfulOutputs
        ) {
          continue;
        }
        try {
          if (
            tracked.identityPath &&
            !(await sameFilesystemEntry(tracked.identityPath, path))
          ) {
            continue;
          }
          if (
            tracked.identity &&
            !(await pathHasIdentity(path, tracked.identity))
          ) {
            continue;
          }
          await rm(path, { recursive: true, force: true });
        } catch {
          // Cleanup is best-effort, especially during process interruption.
        }
      }
    })();
    return this.cleanupPromise;
  }
}

type VerifiedSnapshot = {
  path: string;
  sizeBytes: number;
};

type PreparedOutput = {
  exportId: string;
  outputDirectory: string;
  stagingDirectory: string;
  managed: boolean;
  stagingIdentity: FilesystemIdentity;
  artifacts: PreparedArtifact[];
};

type PreparedArtifact = {
  stagingPath: string;
  finalPath: string;
};

function errorCode(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return undefined;
  }
  return error.code;
}

function sourceReadError(
  error: unknown,
): SourceFileUnavailableError | SourceFileUnreadableError {
  return errorCode(error) === "ENOENT"
    ? new SourceFileUnavailableError()
    : new SourceFileUnreadableError();
}

function outputDirectoryError(): PageExtractionError {
  return new PageExtractionError(
    "OUTPUT_DIRECTORY_ERROR",
    "Unable to create or write the output directory",
  );
}

function outputCollisionError(): PageExtractionError {
  return new PageExtractionError(
    "OUTPUT_COLLISION",
    "An output entry already exists",
  );
}

function artifactWriteError(error: unknown): PageExtractionError {
  return errorCode(error) === "EEXIST"
    ? outputCollisionError()
    : outputDirectoryError();
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw outputDirectoryError();
  }
}

async function sameFilesystemEntry(
  leftPath: string,
  rightPath: string,
): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      lstat(leftPath),
      lstat(rightPath),
    ]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

async function pathIdentity(path: string): Promise<FilesystemIdentity> {
  const entry = await lstat(path, { bigint: true });
  return { dev: entry.dev, ino: entry.ino };
}

async function pathHasIdentity(
  path: string,
  expected: FilesystemIdentity,
): Promise<boolean> {
  try {
    const actual = await pathIdentity(path);
    return actual.dev === expected.dev && actual.ino === expected.ino;
  } catch {
    return false;
  }
}

async function requirePathIdentity(
  path: string,
  expected: FilesystemIdentity,
): Promise<void> {
  if (!(await pathHasIdentity(path, expected))) {
    throw outputCollisionError();
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    if (bytesWritten === 0) throw new SourceFileUnreadableError();
    offset += bytesWritten;
  }
}

function parseSafePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(parsed);
}

export function parsePageSelector(selector: string): ParsedPageSelection {
  if (selector.trim().length === 0) {
    throw new PageExtractionError(
      "INVALID_PAGE_SELECTOR",
      "Page selector must not be empty",
    );
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const rawEntry of selector.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      throw new PageExtractionError(
        "INVALID_PAGE_SELECTOR",
        "Page selector contains an empty entry",
      );
    }

    const match = entry.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) {
      throw new PageExtractionError(
        "INVALID_PAGE_SELECTOR",
        "Page selector is malformed",
      );
    }

    const first = parseSafePositiveInteger(match[1]!);
    const second = match[2]
      ? parseSafePositiveInteger(match[2])
      : first;
    if (first === undefined || second === undefined) {
      throw new PageExtractionError(
        "INVALID_PAGE_SELECTOR",
        "Page numbers must be positive safe integers",
      );
    }

    ranges.push({
      start: Math.min(first, second),
      end: Math.max(first, second),
    });
  }

  return { ranges };
}

export function resolvePageSelection(
  selection: ParsedPageSelection,
  pageCount: number,
): number[] {
  const pages = new Set<number>();
  for (const range of selection.ranges) {
    if (range.end > pageCount) {
      throw new PageExtractionError(
        "PAGE_OUT_OF_RANGE",
        "Selected page is outside the source document",
      );
    }
    for (let page = range.start; page <= range.end; page++) {
      pages.add(page);
    }
  }
  return [...pages].sort((left, right) => left - right);
}

export function parsePageExportFormats(
  value: string | undefined,
): ReadonlySet<PageExportFormat> {
  if (value === undefined) return new Set(["pdf"]);

  const formats = new Set<PageExportFormat>();
  for (const rawFormat of value.split(",")) {
    const format = rawFormat.trim();
    if (format !== "pdf" && format !== "png") {
      throw new PageExtractionError(
        "INVALID_OUTPUT_FORMAT",
        "Output format must be pdf, png, or pdf,png",
      );
    }
    formats.add(format);
  }
  if (formats.size === 0) {
    throw new PageExtractionError(
      "INVALID_OUTPUT_FORMAT",
      "Output format must not be empty",
    );
  }
  return formats;
}

export function parsePngWidth(
  value: unknown,
  outputFormats: ReadonlySet<PageExportFormat>,
): number {
  if (value === undefined) return 1600;
  if (!outputFormats.has("png")) {
    throw new PageExtractionError(
      "INVALID_FLAG_COMBINATION",
      "--png-width requires PNG output",
    );
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new PageExtractionError(
      "INVALID_PNG_WIDTH",
      "--png-width must be an integer from 100 through 10000",
    );
  }
  const width = Number(value);
  if (!Number.isInteger(width) || width < 100 || width > 10_000) {
    throw new PageExtractionError(
      "INVALID_PNG_WIDTH",
      "--png-width must be an integer from 100 through 10000",
    );
  }
  return width;
}

export function isSafeDocumentId(id: string): boolean {
  if (
    id.length === 0 ||
    id === "." ||
    id === ".." ||
    id.endsWith(".") ||
    id.endsWith(" ") ||
    /[\/\\<>:"|?*\u0000-\u001f\u007f-\u009f]/.test(id)
  ) {
    return false;
  }

  const basename = id.split(".")[0]?.toUpperCase();
  return !(
    basename === "CON" ||
    basename === "PRN" ||
    basename === "AUX" ||
    basename === "NUL" ||
    /^COM[1-9]$/.test(basename ?? "") ||
    /^LPT[1-9]$/.test(basename ?? "")
  );
}

function generateExportId(): string {
  let id = "";
  while (id.length < EXPORT_ID_LENGTH) {
    for (const byte of randomBytes(EXPORT_ID_LENGTH * 2)) {
      if (byte >= RANDOM_BYTE_LIMIT) continue;
      id += EXPORT_ID_ALPHABET[byte % EXPORT_ID_ALPHABET.length]!;
      if (id.length === EXPORT_ID_LENGTH) break;
    }
  }
  return id;
}

async function createVerifiedSnapshot(
  sourcePath: string,
  expectedIdentity: SourceIdentity,
  cleanup: InvocationCleanup,
): Promise<VerifiedSnapshot> {
  let sourceHandle: FileHandle;
  try {
    sourceHandle = await open(sourcePath, "r");
  } catch (error) {
    throw sourceReadError(error);
  }
  try {
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile()) throw new SourceFileUnreadableError();

    const directory = await mkdtemp(join(tmpdir(), "poink-snapshot-"));
    cleanup.track(directory, "always");
    try {
      await chmod(directory, MANAGED_DIRECTORY_MODE);
    } catch {
      // Permission narrowing is best-effort on unsupported filesystems.
    }

    const snapshotPath = join(directory, "source.pdf");
    const handle = await open(snapshotPath, "wx", PRIVATE_FILE_MODE);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const chunk of sourceHandle.createReadStream({
        autoClose: false,
      })) {
        const bytes =
          typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        hash.update(bytes);
        sizeBytes += bytes.length;
        await writeAll(handle, bytes);
      }
    } catch (error) {
      throw sourceReadError(error);
    } finally {
      await handle.close();
    }

    const actualHash = hash.digest();
    const expectedHash = Buffer.from(expectedIdentity.hash, "hex");
    if (
      actualHash.length !== expectedHash.length ||
      !timingSafeEqual(actualHash, expectedHash)
    ) {
      throw new SourceFileChangedError();
    }

    return { path: snapshotPath, sizeBytes };
  } finally {
    await sourceHandle.close();
  }
}

function buildFilenames(
  documentId: string,
  exportId: string,
  pages: readonly number[],
  formats: ReadonlySet<PageExportFormat>,
  managed: boolean,
): string[] {
  const suffix = managed ? "" : `-${exportId}`;
  const filenames: string[] = [];
  if (formats.has("pdf")) filenames.push(`${documentId}${suffix}.pdf`);
  if (formats.has("png")) {
    for (const page of pages) {
      filenames.push(
        `${documentId}${suffix}-page-${String(page).padStart(4, "0")}.png`,
      );
    }
  }
  return filenames;
}

function buildArtifacts(
  filenames: readonly string[],
  stagingDirectory: string,
  outputDirectory: string,
): PreparedArtifact[] {
  return filenames.map((filename) => ({
    stagingPath: join(stagingDirectory, filename),
    finalPath: join(outputDirectory, filename),
  }));
}

function preparedOutput(
  exportId: string,
  outputDirectory: string,
  stagingDirectory: string,
  managed: boolean,
  stagingIdentity: FilesystemIdentity,
  filenames: readonly string[],
): PreparedOutput {
  return {
    exportId,
    outputDirectory,
    stagingDirectory,
    managed,
    stagingIdentity,
    artifacts: buildArtifacts(
      filenames,
      stagingDirectory,
      outputDirectory,
    ),
  };
}

async function canonicalExplicitDirectory(
  requestedPath: string,
  cwd: string,
): Promise<string> {
  const expanded = expandHomePath(requestedPath);
  const absolute = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(cwd, expanded);
  try {
    await mkdir(absolute, { recursive: true });
    const outputStat = await stat(absolute);
    if (!outputStat.isDirectory()) throw outputDirectoryError();
    return await realpath(absolute);
  } catch (error) {
    if (error instanceof PageExtractionError) throw error;
    throw outputDirectoryError();
  }
}

async function prepareManagedOutput(
  documentId: string,
  pages: readonly number[],
  formats: ReadonlySet<PageExportFormat>,
  cleanup: InvocationCleanup,
): Promise<PreparedOutput> {
  const root = join(tmpdir(), "poink");
  try {
    await mkdir(root, { recursive: true, mode: MANAGED_DIRECTORY_MODE });
  } catch {
    throw outputDirectoryError();
  }

  for (let attempt = 0; attempt < EXPORT_ID_ATTEMPTS; attempt++) {
    const exportId = generateExportId();
    const outputDirectory = join(root, exportId);
    try {
      await mkdir(outputDirectory, { mode: MANAGED_DIRECTORY_MODE });
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw outputDirectoryError();
    }
    cleanup.track(outputDirectory, "on-failure");
    const stagingDirectory = join(outputDirectory, ".stage");
    try {
      await mkdir(stagingDirectory, { mode: MANAGED_DIRECTORY_MODE });
    } catch {
      throw outputDirectoryError();
    }
    const stagingIdentity = await pathIdentity(stagingDirectory);
    cleanup.track(stagingDirectory, "always", {
      identity: stagingIdentity,
    });
    const filenames = buildFilenames(
      documentId,
      exportId,
      pages,
      formats,
      true,
    );
    return preparedOutput(
      exportId,
      outputDirectory,
      stagingDirectory,
      true,
      stagingIdentity,
      filenames,
    );
  }
  throw outputCollisionError();
}

async function prepareExplicitOutput(
  requestedPath: string,
  cwd: string,
  documentId: string,
  pages: readonly number[],
  formats: ReadonlySet<PageExportFormat>,
  cleanup: InvocationCleanup,
): Promise<PreparedOutput> {
  const outputDirectory = await canonicalExplicitDirectory(requestedPath, cwd);

  for (let attempt = 0; attempt < EXPORT_ID_ATTEMPTS; attempt++) {
    const exportId = generateExportId();
    const filenames = buildFilenames(
      documentId,
      exportId,
      pages,
      formats,
      false,
    );
    let collision = false;
    for (const filename of filenames) {
      if (await pathEntryExists(join(outputDirectory, filename))) {
        collision = true;
        break;
      }
    }
    if (collision) continue;

    const stagingDirectory = join(
      outputDirectory,
      `.poink-export-${exportId}.stage`,
    );
    try {
      await mkdir(stagingDirectory, { mode: MANAGED_DIRECTORY_MODE });
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw outputDirectoryError();
    }
    const stagingIdentity = await pathIdentity(stagingDirectory);
    cleanup.track(stagingDirectory, "always", {
      identity: stagingIdentity,
    });
    return preparedOutput(
      exportId,
      outputDirectory,
      stagingDirectory,
      false,
      stagingIdentity,
      filenames,
    );
  }
  throw outputCollisionError();
}

async function prepareOutput(
  documentId: string,
  pages: readonly number[],
  options: PageExtractionOptions,
  cleanup: InvocationCleanup,
): Promise<PreparedOutput> {
  if (options.outputDirectory === undefined) {
    return prepareManagedOutput(
      documentId,
      pages,
      options.outputFormats,
      cleanup,
    );
  }
  return prepareExplicitOutput(
    options.outputDirectory,
    options.cwd ?? process.cwd(),
    documentId,
    pages,
    options.outputFormats,
    cleanup,
  );
}

async function writeStagedArtifact(
  artifact: PreparedArtifact,
  data: Uint8Array,
  stagingDirectory: string,
  stagingIdentity: FilesystemIdentity,
): Promise<void> {
  try {
    await requirePathIdentity(stagingDirectory, stagingIdentity);
    await writeFile(artifact.stagingPath, data, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
  } catch (error) {
    throw artifactWriteError(error);
  }
}

async function writePdfArtifact(
  sourcePdf: PDFDocument,
  pages: readonly number[],
  artifact: PreparedArtifact,
  stagingDirectory: string,
  stagingIdentity: FilesystemIdentity,
): Promise<void> {
  let bytes: Uint8Array;
  try {
    const exported = await PDFDocument.create();
    const copiedPages = await exported.copyPages(
      sourcePdf,
      pages.map((page) => page - 1),
    );
    for (const page of copiedPages) exported.addPage(page);
    bytes = await exported.save();
  } catch {
    throw new PageExtractionError(
      "PDF_COPY_FAILED",
      "Unable to copy the selected PDF pages",
    );
  }
  await writeStagedArtifact(
    artifact,
    bytes,
    stagingDirectory,
    stagingIdentity,
  );
}

async function writePngArtifacts(
  snapshotBytes: Uint8Array,
  pages: readonly number[],
  width: number,
  artifacts: readonly PreparedArtifact[],
  stagingDirectory: string,
  stagingIdentity: FilesystemIdentity,
): Promise<void> {
  let parser: PDFParse;
  try {
    parser = new PDFParse({ data: snapshotBytes.slice() });
  } catch {
    throw new PageExtractionError(
      "PNG_RENDER_FAILED",
      "Unable to render the selected PDF pages",
    );
  }
  try {
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]!;
      let result: Awaited<ReturnType<PDFParse["getScreenshot"]>>;
      try {
        result = await parser.getScreenshot({
          partial: [page],
          desiredWidth: width,
          imageBuffer: true,
          imageDataUrl: false,
        });
      } catch {
        throw new PageExtractionError(
          "PNG_RENDER_FAILED",
          "Unable to render the selected PDF pages",
        );
      }
      const screenshot = result.pages[0];
      if (
        !screenshot ||
        screenshot.pageNumber !== page ||
        Math.abs(screenshot.width - width) > 1
      ) {
        throw new PageExtractionError(
          "PNG_RENDER_FAILED",
          "Unable to render the selected PDF pages",
        );
      }
      await writeStagedArtifact(
        artifacts[index]!,
        screenshot.data,
        stagingDirectory,
        stagingIdentity,
      );
    }
  } finally {
    try {
      await parser.destroy();
    } catch {
      // Rendering result remains authoritative; cleanup is best-effort.
    }
  }
}

async function publishArtifacts(
  prepared: PreparedOutput,
  cleanup: InvocationCleanup,
): Promise<void> {
  await requirePathIdentity(
    prepared.stagingDirectory,
    prepared.stagingIdentity,
  );
  if (!prepared.managed) {
    const publishedMode = 0o666 & ~process.umask();
    for (const artifact of prepared.artifacts) {
      await chmod(artifact.stagingPath, publishedMode);
    }
  }

  const published: PreparedArtifact[] = [];
  try {
    for (const artifact of prepared.artifacts) {
      try {
        await link(artifact.stagingPath, artifact.finalPath);
      } catch (error) {
        if (errorCode(error) === "EEXIST") throw outputCollisionError();
        throw outputDirectoryError();
      }
      published.push(artifact);
      cleanup.track(artifact.finalPath, "on-failure", {
        identityPath: artifact.stagingPath,
      });
    }
    for (const artifact of prepared.artifacts) {
      if (
        !(await sameFilesystemEntry(
          artifact.stagingPath,
          artifact.finalPath,
        ))
      ) {
        throw outputCollisionError();
      }
    }
  } catch (error) {
    for (const artifact of published.reverse()) {
      try {
        if (
          await sameFilesystemEntry(
            artifact.stagingPath,
            artifact.finalPath,
          )
        ) {
          await unlink(artifact.finalPath);
        }
      } catch {
        // Preserve unrelated entries; only known invocation paths are touched.
      } finally {
        cleanup.untrack(artifact.finalPath);
      }
    }
    throw error;
  }
}

export async function extractStoredPdfPages(
  document: Document,
  sourceIdentity: SourceIdentity,
  selection: ParsedPageSelection,
  options: PageExtractionOptions,
): Promise<PageExtractionResult> {
  const cleanup = new InvocationCleanup();
  const removeSignalHandlers = cleanup.installSignalHandlers();
  try {
    const snapshot = await createVerifiedSnapshot(
      document.path,
      sourceIdentity,
      cleanup,
    );
    const snapshotBytes = new Uint8Array(await readFile(snapshot.path));

    let sourcePdf: PDFDocument;
    try {
      sourcePdf = await PDFDocument.load(snapshotBytes);
    } catch {
      throw new PageExtractionError(
        options.outputFormats.has("pdf")
          ? "PDF_COPY_FAILED"
          : "PNG_RENDER_FAILED",
        "Unable to load the source PDF",
      );
    }

    if (
      snapshot.sizeBytes !== document.sizeBytes ||
      sourcePdf.getPageCount() !== document.pageCount
    ) {
      throw new PageExtractionError(
        "SOURCE_METADATA_MISMATCH",
        "Stored source metadata does not match the verified PDF",
      );
    }

    const pages = resolvePageSelection(selection, sourcePdf.getPageCount());
    const prepared = await prepareOutput(
      document.id,
      pages,
      options,
      cleanup,
    );
    let artifactIndex = 0;

    if (options.outputFormats.has("pdf")) {
      await writePdfArtifact(
        sourcePdf,
        pages,
        prepared.artifacts[artifactIndex]!,
        prepared.stagingDirectory,
        prepared.stagingIdentity,
      );
      artifactIndex++;
    }
    if (options.outputFormats.has("png")) {
      await writePngArtifacts(
        snapshotBytes,
        pages,
        options.pngWidth,
        prepared.artifacts.slice(artifactIndex),
        prepared.stagingDirectory,
        prepared.stagingIdentity,
      );
    }

    await cleanup.runPublicationCritical(() =>
      publishArtifacts(prepared, cleanup),
    );
    await rm(prepared.stagingDirectory, { recursive: true, force: true });
    cleanup.untrack(prepared.stagingDirectory);

    if (cleanup.wasInterrupted()) {
      throw new PageExtractionError(
        "INTERRUPTED",
        "Page extraction was interrupted",
      );
    }

    cleanup.markSuccessful();
    for (const artifact of prepared.artifacts) {
      cleanup.untrack(artifact.finalPath);
    }
    cleanup.untrack(prepared.outputDirectory);
    return {
      exportId: prepared.exportId,
      docId: document.id,
      pages,
      outputDirectory: prepared.outputDirectory,
      files: prepared.artifacts.map((artifact) => artifact.finalPath),
    };
  } finally {
    removeSignalHandlers();
    await cleanup.cleanup();
  }
}
