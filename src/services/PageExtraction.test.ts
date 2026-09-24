import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
  parsePageExportFormats,
  parsePageSelector,
  parsePngWidth,
  resolvePageSelection,
  type PageExtractionOptions,
} from "./PageExtraction.js";
import {
  SourceFileChangedError,
  type SourceIdentity,
} from "./SourceIntegrity.js";

const tempDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Page n is (240 + n) x (360 + n) points; page 2 is rotated 90 degrees. */
async function createPdf(pageCount = 3): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = pdf.addPage([240 + pageNumber, 360 + pageNumber]);
    if (pageNumber === 2) page.setRotation(degrees(90));
    page.drawText(`Page ${pageNumber}`, { x: 20, y: 300 });
  }
  return pdf.save();
}

type StoredPdf = {
  root: string;
  sourcePath: string;
  document: Document;
  identity: SourceIdentity;
};

async function createStoredPdf(pageCount = 3): Promise<StoredPdf> {
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

/**
 * Extracts `selector` from `stored` as a PDF at the default PNG width unless
 * overridden. Omitting `outputDirectory` selects managed output.
 */
function extractPages(
  stored: StoredPdf,
  selector: string,
  overrides: Partial<PageExtractionOptions> & {
    document?: Document;
    identity?: SourceIdentity;
  } = {},
) {
  const {
    document = stored.document,
    identity = stored.identity,
    ...options
  } = overrides;
  return extractStoredPdfPages(
    document,
    identity,
    parsePageSelector(selector),
    { outputFormats: new Set(["pdf"]), pngWidth: 1600, ...options },
  );
}

function fakeScreenshot() {
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
}

/** Export ID of the explicit-output staging directory inside `output`. */
function stagedExportId(output: string): string {
  const exportId = readdirSync(output)
    .map((name) => name.match(/^\.poink-export-([a-z0-9]{8})\.stage$/)?.[1])
    .find((id) => id !== undefined);
  if (!exportId) throw new Error("staging directory not found");
  return exportId;
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
  test("exports a PDF with normalized source-page order and rotation", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "exports");
    const result = await extractPages(stored, "3,2,3", {
      outputDirectory: output,
    });

    expect(result.pages).toEqual([2, 3]);
    expect(result.outputDirectory).toBe(output);
    expect(result.files.map((path) => basename(path))).toEqual([
      `abc123-${result.exportId}.pdf`,
    ]);
    const exported = await PDFDocument.load(readFileSync(result.files[0]!));
    expect(
      exported.getPages().map((page) => ({
        ...page.getSize(),
        rotation: page.getRotation().angle,
      })),
    ).toEqual([
      { width: 242, height: 362, rotation: 90 },
      { width: 243, height: 363, rotation: 0 },
    ]);
    if (process.platform !== "win32") {
      expect(statSync(result.files[0]!).mode & 0o777).toBe(
        0o666 & ~process.umask(),
      );
    }
  });

  test("renders PNG pages sequentially from the verified snapshot", async () => {
    const stored = await createStoredPdf();
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
        // Rendering must read the snapshot, not the now-changed source.
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

    const result = await extractPages(stored, "1-2", {
      outputFormats: new Set(["png"]),
      outputDirectory: join(stored.root, "images"),
      pngWidth: 320,
    });

    expect(maxActive).toBe(1);
    expect(calls).toEqual([[1], [2]]);
    expect(renderedWidths.every((width) => Math.abs(width - 320) <= 1)).toBe(
      true,
    );
    expect(result.files.map((path) => basename(path))).toEqual([
      `abc123-${result.exportId}-page-0001.png`,
      `abc123-${result.exportId}-page-0002.png`,
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
    const result = await extractPages(stored, "3,1", {
      outputFormats: new Set(["png", "pdf"]),
      outputDirectory: output,
      pngWidth: 200,
    });

    expect(result.exportId).toMatch(/^[a-z0-9]{8}$/);
    expect(readdirSync(output).sort()).toEqual(
      result.files.map((path) => basename(path)).sort(),
    );
    expect(result.files.map((path) => basename(path))).toEqual([
      `abc123-${result.exportId}.pdf`,
      `abc123-${result.exportId}-page-0001.png`,
      `abc123-${result.exportId}-page-0003.png`,
    ]);
  });

  test("names managed output after the export ID and omits it from artifacts", async () => {
    const stored = await createStoredPdf();
    const result = await extractPages(stored, "2");
    tempDirectories.push(result.outputDirectory);

    expect(basename(result.outputDirectory)).toBe(result.exportId);
    expect(result.files.map((path) => basename(path))).toEqual([
      "abc123.pdf",
    ]);
  });

  test.skipIf(process.platform === "win32")(
    "uses private permissions for managed output",
    async () => {
      const stored = await createStoredPdf();
      const result = await extractPages(stored, "1");
      tempDirectories.push(result.outputDirectory);

      expect(statSync(result.outputDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(result.files[0]!).mode & 0o777).toBe(0o600);
    },
  );

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

    const result = await extractPages(stored, "1", { outputDirectory: linked });

    const canonicalTarget = realpathSync(target);
    expect(result.outputDirectory).toBe(canonicalTarget);
    expect(result.files[0]!.startsWith(canonicalTarget)).toBe(true);
  });

  test("fails source verification without leaking the hash or creating output", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "must-not-exist");
    const secretHash = "f".repeat(64);

    const failure: unknown = await extractPages(stored, "1", {
      identity: { algorithm: "sha256", hash: secretHash },
      outputDirectory: output,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SourceFileChangedError);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).not.toContain(secretHash);
    expect(message).not.toContain("poink-snapshot-");
    expect(existsSync(output)).toBe(false);
  });

  test.each([
    ["SOURCE_FILE_UNAVAILABLE", (root: string) => join(root, "missing.pdf")],
    ["SOURCE_FILE_UNREADABLE", (root: string) => root],
  ] as const)("rejects a source path with %s", async (tag, sourcePath) => {
    const stored = await createStoredPdf();
    const document = new Document({
      ...stored.document,
      path: sourcePath(stored.root),
    });

    await expect(
      extractPages(stored, "1", { document }),
    ).rejects.toMatchObject({ _tag: tag });
  });

  test.each([
    ["page count", { pageCount: 4 }],
    ["byte count", { sizeBytes: 1 }],
  ] as const)(
    "rejects a stored %s mismatch without publishing artifacts",
    async (_field, mismatch) => {
      const stored = await createStoredPdf();
      const output = join(stored.root, "mismatch");

      await expect(
        extractPages(stored, "1", {
          document: new Document({ ...stored.document, ...mismatch }),
          outputDirectory: output,
        }),
      ).rejects.toMatchObject({ _tag: "SOURCE_METADATA_MISMATCH" });
      expect(existsSync(output)).toBe(false);
    },
  );

  test("rejects a non-directory output path without replacing it", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "not-a-directory");
    writeFileSync(output, "keep me");

    await expect(
      extractPages(stored, "1", { outputDirectory: output }),
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
        return fakeScreenshot();
      },
    );

    await expect(
      extractPages(stored, "1-2", {
        outputFormats: new Set(["pdf", "png"]),
        outputDirectory: output,
        pngWidth: 200,
      }),
    ).rejects.toMatchObject({ _tag: "PNG_RENDER_FAILED" });

    expect(readdirSync(output)).toEqual([]);
  });

  test("does not overwrite an entry that appears after rendering", async () => {
    const stored = await createStoredPdf();
    const output = join(stored.root, "late-collision");
    vi.spyOn(PDFParse.prototype, "getScreenshot").mockImplementation(
      async () => {
        writeFileSync(
          join(output, `abc123-${stagedExportId(output)}-page-0001.png`),
          "unrelated entry",
        );
        return fakeScreenshot();
      },
    );

    await expect(
      extractPages(stored, "1", {
        outputFormats: new Set(["pdf", "png"]),
        outputDirectory: output,
        pngWidth: 200,
      }),
    ).rejects.toMatchObject({ _tag: "OUTPUT_COLLISION" });

    const entries = readdirSync(output);
    expect(entries).toHaveLength(1);
    expect(readFileSync(join(output, entries[0]!), "utf8")).toBe(
      "unrelated entry",
    );
  });

  test.skipIf(process.platform === "win32")(
    "treats a late broken symlink as a collision",
    async () => {
      const stored = await createStoredPdf();
      const output = join(stored.root, "late-symlink-collision");
      vi.spyOn(PDFParse.prototype, "getScreenshot").mockImplementation(
        async () => {
          symlinkSync(
            "missing-target",
            join(output, `abc123-${stagedExportId(output)}-page-0001.png`),
          );
          return fakeScreenshot();
        },
      );

      await expect(
        extractPages(stored, "1", {
          outputFormats: new Set(["png"]),
          outputDirectory: output,
          pngWidth: 200,
        }),
      ).rejects.toMatchObject({ _tag: "OUTPUT_COLLISION" });
      const entries = readdirSync(output);
      expect(entries).toHaveLength(1);
      expect(lstatSync(join(output, entries[0]!)).isSymbolicLink()).toBe(true);
    },
  );

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
});
