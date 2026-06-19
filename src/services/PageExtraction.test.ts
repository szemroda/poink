import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PDFDocument, degrees } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Document } from "../types.js";
import {
  extractStoredPdfPages,
  isSafeDocumentId,
  PageExtractionError,
  parsePageExportFormats,
  parsePageSelector,
  parsePngWidth,
  resolvePageSelection,
} from "./PageExtraction.js";

const tempDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function createPdf(pageCount = 3): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = pdf.addPage([240 + pageNumber, 360 + pageNumber]);
    if (pageNumber === 2) page.setRotation(degrees(90));
    page.drawText(`Page ${pageNumber}`, { x: 20, y: 300 });
  }
  return pdf.save();
}

async function createStoredPdf(pageCount = 3): Promise<{
  root: string;
  sourcePath: string;
  document: Document;
  identity: { algorithm: "sha256"; hash: string };
}> {
  const root = mkdtempSync(join(tmpdir(), "poink-page-extract-"));
  tempDirectories.push(root);
  const sourcePath = join(root, "source.pdf");
  const bytes = await createPdf(pageCount);
  writeFileSync(sourcePath, bytes);
  return {
    root,
    sourcePath,
    document: new Document({
      id: "abc123",
      title: "Stored PDF",
      path: sourcePath,
      addedAt: new Date("2026-01-01T00:00:00.000Z"),
      pageCount,
      sizeBytes: bytes.length,
      tags: [],
      fileType: "pdf",
    }),
    identity: {
      algorithm: "sha256",
      hash: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

describe("page extraction validation", () => {
  test("normalizes selectors, descending ranges, duplicates, and leading zeros", () => {
    const selection = parsePageSelector(" 005, 2, 7-5, 2 ");
    expect(resolvePageSelection(selection, 10)).toEqual([2, 5, 6, 7]);
  });

  test.each([
    "",
    "1,",
    ",1",
    "0",
    "-1",
    "1--2",
    "1-2-3",
    "9007199254740992",
  ])("rejects malformed selector %j", (selector) => {
    expect(() => parsePageSelector(selector)).toThrow(
      expect.objectContaining({ _tag: "INVALID_PAGE_SELECTOR" }),
    );
  });

  test("rejects out-of-range pages before expanding a huge range", () => {
    const selection = parsePageSelector("1-9007199254740991");
    expect(() => resolvePageSelection(selection, 10)).toThrow(
      expect.objectContaining({ _tag: "PAGE_OUT_OF_RANGE" }),
    );
  });

  test("normalizes output formats and validates PNG width combinations", () => {
    expect([...parsePageExportFormats(undefined)]).toEqual(["pdf"]);
    expect([...parsePageExportFormats(" png, pdf, png ")]).toEqual([
      "png",
      "pdf",
    ]);
    expect(parsePngWidth(undefined, new Set(["png"]))).toBe(1600);
    expect(parsePngWidth("2000", new Set(["png"]))).toBe(2000);
    expect(() => parsePageExportFormats("")).toThrow(
      expect.objectContaining({ _tag: "INVALID_OUTPUT_FORMAT" }),
    );
    expect(() => parsePngWidth("2000", new Set(["pdf"]))).toThrow(
      expect.objectContaining({ _tag: "INVALID_FLAG_COMBINATION" }),
    );
    expect(() => parsePngWidth("99", new Set(["png"]))).toThrow(
      expect.objectContaining({ _tag: "INVALID_PNG_WIDTH" }),
    );
  });

  test("rejects unsafe filename components", () => {
    expect(isSafeDocumentId("abc123")).toBe(true);
    for (const id of [
      "..",
      "a/b",
      "a\\b",
      "a:b",
      "a\u0000b",
      "a\u0085b",
      "CON",
      "lpt1.pdf",
      "trailing.",
    ]) {
      expect(isSafeDocumentId(id), id).toBe(false);
    }
  });
});

describe("page extraction artifacts", () => {
  test("exports a PDF with normalized source-page order", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "exports");
    const result = await extractStoredPdfPages(
      stored.document,
      stored.identity,
      parsePageSelector("3,1,3"),
      {
        outputFormats: new Set(["pdf"]),
        outputDirectory: output,
        pngWidth: 1600,
      },
    );

    expect(result.pages).toEqual([1, 3]);
    expect(result.outputDirectory).toBe(output);
    expect(result.files).toHaveLength(1);
    expect(basename(result.files[0]!)).toMatch(
      /^abc123-[a-z0-9]{8}\.pdf$/,
    );
    const exported = await PDFDocument.load(readFileSync(result.files[0]!));
    expect(exported.getPageCount()).toBe(2);
    expect(exported.getPage(0).getSize()).toEqual(
      expect.objectContaining({ width: 241, height: 361 }),
    );
    expect(exported.getPage(1).getSize()).toEqual(
      expect.objectContaining({ width: 243, height: 363 }),
    );
    if (process.platform !== "win32") {
      expect(statSync(result.files[0]!).mode & 0o777).toBe(
        0o666 & ~process.umask(),
      );
    }
  });

  test("renders PNG pages sequentially from the verified snapshot", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "images");
    const originalGetScreenshot = PDFParse.prototype.getScreenshot;
    let active = 0;
    let maxActive = 0;
    const calls: number[][] = [];
    const renderedWidths: number[] = [];
    vi.spyOn(PDFParse.prototype, "getScreenshot").mockImplementation(
      async function (this: PDFParse, parameters) {
        active++;
        maxActive = Math.max(maxActive, active);
        calls.push(parameters?.partial ?? []);
        if (calls.length === 1) {
          writeFileSync(stored.sourcePath, "changed after snapshot");
        }
        try {
          const result = await originalGetScreenshot.call(this, parameters);
          renderedWidths.push(...result.pages.map((page) => page.width));
          return result;
        } finally {
          active--;
        }
      },
    );

    const result = await extractStoredPdfPages(
      stored.document,
      stored.identity,
      parsePageSelector("1-2"),
      {
        outputFormats: new Set(["png"]),
        outputDirectory: output,
        pngWidth: 320,
      },
    );

    expect(maxActive).toBe(1);
    expect(calls).toEqual([[1], [2]]);
    expect(renderedWidths.every((width) => Math.abs(width - 320) <= 1)).toBe(
      true,
    );
    expect(result.files.map((path) => basename(path))).toEqual([
      expect.stringMatching(/^abc123-[a-z0-9]{8}-page-0001\.png$/),
      expect.stringMatching(/^abc123-[a-z0-9]{8}-page-0002\.png$/),
    ]);
    for (const path of result.files) {
      expect(readFileSync(path).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    }
  });

  test("publishes PDF first and PNGs in ascending page order", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "combined");
    const result = await extractStoredPdfPages(
      stored.document,
      stored.identity,
      parsePageSelector("3,1"),
      {
        outputFormats: new Set(["png", "pdf"]),
        outputDirectory: output,
        pngWidth: 200,
      },
    );

    expect(result.files.map((path) => basename(path))).toEqual([
      expect.stringMatching(/^abc123-([a-z0-9]{8})\.pdf$/),
      expect.stringMatching(/^abc123-([a-z0-9]{8})-page-0001\.png$/),
      expect.stringMatching(/^abc123-([a-z0-9]{8})-page-0003\.png$/),
    ]);
    const exportIds = result.files.map(
      (path) => basename(path).match(/^abc123-([a-z0-9]{8})/)?.[1],
    );
    expect(new Set(exportIds).size).toBe(1);
    expect(result.files.every(existsSync)).toBe(true);
    expect(
      readdirSync(output).some((name) => name.includes(".stage")),
    ).toBe(false);
  });

  test("preserves source page rotation in copied PDFs", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "rotation");
    const result = await extractStoredPdfPages(
      stored.document,
      stored.identity,
      parsePageSelector("2"),
      {
        outputFormats: new Set(["pdf"]),
        outputDirectory: output,
        pngWidth: 1600,
      },
    );
    const exported = await PDFDocument.load(readFileSync(result.files[0]!));
    expect(exported.getPage(0).getRotation().angle).toBe(90);
  });

  test("creates no output directory when source verification fails", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "must-not-exist");

    await expect(
      extractStoredPdfPages(
        stored.document,
        { algorithm: "sha256", hash: "0".repeat(64) },
        parsePageSelector("1"),
        {
          outputFormats: new Set(["pdf"]),
          outputDirectory: output,
          pngWidth: 1600,
        },
      ),
    ).rejects.toMatchObject({ _tag: "SOURCE_FILE_CHANGED" });
    expect(existsSync(output)).toBe(false);
  });

  test("distinguishes unavailable and unreadable source files", async () => {
    const stored = await createStoredPdf();
    const unavailable = new Document({
      ...stored.document,
      path: join(stored.root, "missing.pdf"),
    });
    const unreadable = new Document({
      ...stored.document,
      path: stored.root,
    });

    await expect(
      extractStoredPdfPages(
        unavailable,
        stored.identity,
        parsePageSelector("1"),
        { outputFormats: new Set(["pdf"]), pngWidth: 1600 },
      ),
    ).rejects.toMatchObject({ _tag: "SOURCE_FILE_UNAVAILABLE" });
    await expect(
      extractStoredPdfPages(
        unreadable,
        stored.identity,
        parsePageSelector("1"),
        { outputFormats: new Set(["pdf"]), pngWidth: 1600 },
      ),
    ).rejects.toMatchObject({ _tag: "SOURCE_FILE_UNREADABLE" });
  });

  test("rejects stored metadata mismatch without publishing artifacts", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "metadata-mismatch");
    const mismatched = new Document({
      ...stored.document,
      pageCount: stored.document.pageCount + 1,
    });

    await expect(
      extractStoredPdfPages(
        mismatched,
        stored.identity,
        parsePageSelector("1"),
        {
          outputFormats: new Set(["pdf"]),
          outputDirectory: output,
          pngWidth: 1600,
        },
      ),
    ).rejects.toMatchObject({ _tag: "SOURCE_METADATA_MISMATCH" });
    expect(existsSync(output)).toBe(false);
  });

  test("rejects stored byte-count mismatch without publishing artifacts", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "size-mismatch");
    const mismatched = new Document({
      ...stored.document,
      sizeBytes: stored.document.sizeBytes + 1,
    });

    await expect(
      extractStoredPdfPages(
        mismatched,
        stored.identity,
        parsePageSelector("1"),
        {
          outputFormats: new Set(["pdf"]),
          outputDirectory: output,
          pngWidth: 1600,
        },
      ),
    ).rejects.toMatchObject({ _tag: "SOURCE_METADATA_MISMATCH" });
    expect(existsSync(output)).toBe(false);
  });

  test("rejects a non-directory output path without replacing it", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "not-a-directory");
    writeFileSync(output, "keep me");

    await expect(
      extractStoredPdfPages(
        stored.document,
        stored.identity,
        parsePageSelector("1"),
        {
          outputFormats: new Set(["pdf"]),
          outputDirectory: output,
          pngWidth: 1600,
        },
      ),
    ).rejects.toMatchObject({ _tag: "OUTPUT_DIRECTORY_ERROR" });
    expect(readFileSync(output, "utf8")).toBe("keep me");
  });

  test("removes staged and published artifacts after rendering failure", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "failed-render");
    let call = 0;
    vi.spyOn(PDFParse.prototype, "getScreenshot").mockImplementation(
      async () => {
        call++;
        if (call === 2) throw new Error("renderer failed");
        return {
          total: 1,
          pages: [
            {
              data: new Uint8Array([1, 2, 3]),
              dataUrl: "",
              pageNumber: 1,
              width: 200,
              height: 300,
              scale: 1,
            },
          ],
        };
      },
    );

    await expect(
      extractStoredPdfPages(
        stored.document,
        stored.identity,
        parsePageSelector("1-2"),
        {
          outputFormats: new Set(["pdf", "png"]),
          outputDirectory: output,
          pngWidth: 200,
        },
      ),
    ).rejects.toMatchObject({ _tag: "PNG_RENDER_FAILED" });

    expect(existsSync(output)).toBe(true);
    expect(readdirSync(output)).toEqual([]);
  });

  test("does not overwrite an entry that appears after rendering", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "late-collision");
    vi.spyOn(PDFParse.prototype, "getScreenshot").mockImplementation(
      async () => {
        const stageName = readdirSync(output).find((name) =>
          name.endsWith(".stage"),
        );
        if (!stageName) throw new Error("staging directory not found");
        const exportId = stageName.match(
          /^\.poink-export-([a-z0-9]{8})\.stage$/,
        )?.[1];
        if (!exportId) throw new Error("export ID not found");
        writeFileSync(
          join(output, `abc123-${exportId}-page-0001.png`),
          "unrelated entry",
        );
        return {
          total: 1,
          pages: [
            {
              data: new Uint8Array([1, 2, 3]),
              dataUrl: "",
              pageNumber: 1,
              width: 200,
              height: 300,
              scale: 1,
            },
          ],
        };
      },
    );

    await expect(
      extractStoredPdfPages(
        stored.document,
        stored.identity,
        parsePageSelector("1"),
        {
          outputFormats: new Set(["pdf", "png"]),
          outputDirectory: output,
          pngWidth: 200,
        },
      ),
    ).rejects.toMatchObject({ _tag: "OUTPUT_COLLISION" });

    const entries = readdirSync(output);
    expect(entries).toHaveLength(1);
    expect(readFileSync(join(output, entries[0]!), "utf8")).toBe(
      "unrelated entry",
    );
  });

  test("treats a late broken symlink as a collision where supported", async () => {
    if (process.platform === "win32") return;
    const stored = await createStoredPdf();
    const output = join(stored.root, "late-symlink-collision");
    vi.spyOn(PDFParse.prototype, "getScreenshot").mockImplementation(
      async () => {
        const stageName = readdirSync(output).find((name) =>
          name.endsWith(".stage"),
        );
        const exportId = stageName?.match(
          /^\.poink-export-([a-z0-9]{8})\.stage$/,
        )?.[1];
        if (!exportId) throw new Error("export ID not found");
        symlinkSync(
          "missing-target",
          join(output, `abc123-${exportId}-page-0001.png`),
        );
        return {
          total: 1,
          pages: [
            {
              data: new Uint8Array([1]),
              dataUrl: "",
              pageNumber: 1,
              width: 200,
              height: 300,
              scale: 1,
            },
          ],
        };
      },
    );

    await expect(
      extractStoredPdfPages(
        stored.document,
        stored.identity,
        parsePageSelector("1"),
        {
          outputFormats: new Set(["png"]),
          outputDirectory: output,
          pngWidth: 200,
        },
      ),
    ).rejects.toMatchObject({ _tag: "OUTPUT_COLLISION" });
    expect(readdirSync(output)).toHaveLength(1);
  });

  test("managed output omits the export ID from artifact names", async () => {
    const stored = await createStoredPdf();
    const result = await extractStoredPdfPages(
      stored.document,
      stored.identity,
      parsePageSelector("2"),
      {
        outputFormats: new Set(["pdf"]),
        pngWidth: 1600,
      },
    );
    tempDirectories.push(result.outputDirectory);

    expect(basename(result.outputDirectory)).toBe(result.exportId);
    expect(result.files.map((path) => basename(path))).toEqual([
      "abc123.pdf",
    ]);
  });

  test("allows an existing output-directory symlink and returns its canonical path", async () => {
    const stored = await createStoredPdf();
    const target = join(stored.root, "symlink-target");
    const linked = join(stored.root, "symlink-output");
    mkdirSync(target);
    try {
      symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    const result = await extractStoredPdfPages(
      stored.document,
      stored.identity,
      parsePageSelector("1"),
      {
        outputFormats: new Set(["pdf"]),
        outputDirectory: linked,
        pngWidth: 1600,
      },
    );

    const canonicalTarget = realpathSync(target);
    expect(result.outputDirectory).toBe(canonicalTarget);
    expect(result.files[0]!.startsWith(canonicalTarget)).toBe(true);
  });

  const signalTest = process.platform === "win32" ? test.skip : test;
  signalTest.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "cleans explicit staging output on %s and exits conventionally",
    async (signal, expectedCode) => {
      const stored = await createStoredPdf();
      const output = join(stored.root, `signal-${signal}`);
      const serializedDocument = {
        id: stored.document.id,
        title: stored.document.title,
        path: stored.sourcePath,
        pageCount: stored.document.pageCount,
        sizeBytes: stored.document.sizeBytes,
        tags: [...stored.document.tags],
        fileType: stored.document.fileType,
      };
      const script = `
        import { PDFParse } from "pdf-parse";
        import { Document } from "./src/types.ts";
        import {
          extractStoredPdfPages,
          parsePageSelector
        } from "./src/services/PageExtraction.ts";

        PDFParse.prototype.getScreenshot = async function () {
          process.stdout.write("READY\\n");
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          throw new Error("unexpected completion");
        };

        const document = new Document({
          ...${JSON.stringify(serializedDocument)},
          addedAt: new Date("2026-01-01T00:00:00.000Z")
        });
        await extractStoredPdfPages(
          document,
          ${JSON.stringify(stored.identity)},
          parsePageSelector("1"),
          {
            outputFormats: new Set(["png"]),
            outputDirectory: ${JSON.stringify(output)},
            pngWidth: 200
          }
        );
      `;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(
          () => rejectReady(new Error(`child was not ready: ${stderr}`)),
          15_000,
        );
        const inspect = () => {
          if (!stdout.includes("READY")) return;
          clearTimeout(timeout);
          child.stdout.off("data", inspect);
          resolveReady();
        };
        child.stdout.on("data", inspect);
        inspect();
      });
      child.kill(signal);
      const exit = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveExit) => {
        child.once("exit", (code, exitSignal) => {
          resolveExit({ code, signal: exitSignal });
        });
      });

      expect(exit).toEqual({ code: expectedCode, signal: null });
      expect(existsSync(output)).toBe(true);
      expect(readdirSync(output)).toEqual([]);
      expect(stdout.trim()).toBe("READY");
      expect(stderr).toBe("");
    },
    25_000,
  );

  test("uses private permissions for managed output where supported", async () => {
    if (process.platform === "win32") return;
    const stored = await createStoredPdf();
    const result = await extractStoredPdfPages(
      stored.document,
      stored.identity,
      parsePageSelector("1"),
      {
        outputFormats: new Set(["pdf"]),
        pngWidth: 1600,
      },
    );
    tempDirectories.push(result.outputDirectory);

    expect(statSync(result.outputDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(result.files[0]!).mode & 0o777).toBe(0o600);
  });

  test("does not include hashes or snapshot paths in integrity errors", async () => {
    const stored = await createStoredPdf();
    const secretHash = "f".repeat(64);
    let failure: unknown;
    try {
      await extractStoredPdfPages(
        stored.document,
        { algorithm: "sha256", hash: secretHash },
        parsePageSelector("1"),
        {
          outputFormats: new Set(["pdf"]),
          outputDirectory: join(stored.root, "unused"),
          pngWidth: 1600,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).not.toContain(secretHash);
    expect(message).not.toContain("poink-snapshot-");
  });

  test("uses a stable error object for output failures", () => {
    expect(
      new PageExtractionError("OUTPUT_COLLISION", "collision"),
    ).toMatchObject({
      _tag: "OUTPUT_COLLISION",
      message: "collision",
    });
  });
});
