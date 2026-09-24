import { afterEach, describe, expect, test } from "vitest";
import { Effect } from "effect";
import {
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryConfig } from "../types.js";
import { MAX_TEXT_SOURCE_BYTES } from "./SourceFileLimits.js";
import {
  makeTextExtractor,
  normalizePlainText,
  TextExtractor,
} from "./TextExtractor.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "text-extractor-"));
  tempDirs.push(directory);
  return join(directory, name);
}

function processText(path: string, chunkSize = 80, chunkOverlap = 0) {
  const layer = makeTextExtractor(
    new LibraryConfig({
      libraryPath: ".",
      dbPath: ":memory:",
      chunkSize,
      chunkOverlap,
    }),
  );
  return TextExtractor.pipe(
    Effect.flatMap((extractor) => extractor.process(path)),
    Effect.provide(layer),
  );
}

test("normalizePlainText strips BOM and null bytes while preserving paragraph breaks", () => {
  expect(
    normalizePlainText("\uFEFFFirst line\r\nSecond\x00 line  \r\n\r\n\r\nThird"),
  ).toBe("First line\nSecond line\n\nThird");
});

describe("TextExtractor", () => {
  test("returns one chunk for a small text file", async () => {
    const path = tempPath("notes.txt");
    writeFileSync(path, "Alpha paragraph.\n\nBeta paragraph.", "utf8");

    await expect(Effect.runPromise(processText(path))).resolves.toEqual({
      pageCount: 1,
      chunks: [
        { page: 1, chunkIndex: 0, content: "Alpha paragraph.\n\nBeta paragraph." },
      ],
    });
  });

  test("splits long text using configured chunk size and overlap", async () => {
    const path = tempPath("long.txt");
    writeFileSync(
      path,
      [
        "Alpha sentence one. Alpha sentence two.",
        "Beta sentence one. Beta sentence two.",
        "Gamma sentence one. Gamma sentence two.",
      ].join("\n\n"),
      "utf8",
    );

    const result = await Effect.runPromise(processText(path, 55, 22));

    expect(result.chunks.map((chunk) => chunk.content)).toEqual([
      "Alpha sentence one. Alpha sentence two.",
      "Alpha sentence two.\n\nBeta sentence one. Beta sentence two.",
      "Beta sentence two.\n\nGamma sentence one. Gamma sentence two.",
    ]);
    expect(result.chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
  });

  test("returns no chunks for an empty text file", async () => {
    const path = tempPath("empty.txt");
    writeFileSync(path, "", "utf8");

    await expect(Effect.runPromise(processText(path))).resolves.toEqual({
      pageCount: 1,
      chunks: [],
    });
  });

  test.each([
    {
      name: "invalid UTF-8",
      write: (path: string) => writeFileSync(path, Buffer.from([0xc3, 0x28])),
      reason: "Plain text source must be valid UTF-8",
    },
    {
      name: "oversized files",
      write: (path: string) => {
        writeFileSync(path, "x");
        truncateSync(path, MAX_TEXT_SOURCE_BYTES + 1);
      },
      reason: expect.stringContaining("exceeds max size"),
    },
  ])("rejects $name", async ({ write, reason }) => {
    const path = tempPath("source.txt");
    write(path);

    await expect(
      Effect.runPromise(Effect.flip(processText(path))),
    ).resolves.toMatchObject({ _tag: "TextExtractionError", reason });
  });
});
