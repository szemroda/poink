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

function config(chunkSize: number, chunkOverlap: number): LibraryConfig {
  return new LibraryConfig({
    libraryPath: ".",
    dbPath: ":memory:",
    chunkSize,
    chunkOverlap,
  });
}

function processText(path: string, chunkSize = 80, chunkOverlap = 0) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const extractor = yield* TextExtractor;
      return yield* extractor.process(path);
    }).pipe(Effect.provide(makeTextExtractor(config(chunkSize, chunkOverlap)))),
  );
}

function processTextEither(path: string, chunkSize = 80, chunkOverlap = 0) {
  return Effect.runPromise(
    Effect.either(
      Effect.gen(function* () {
        const extractor = yield* TextExtractor;
        return yield* extractor.process(path);
      }),
    ).pipe(Effect.provide(makeTextExtractor(config(chunkSize, chunkOverlap)))),
  );
}

describe("plain text normalization", () => {
  test("strips BOM and null bytes while preserving paragraph breaks", () => {
    expect(
      normalizePlainText(
        "\uFEFFFirst line\r\nSecond\x00 line  \r\n\r\n\r\nThird",
      ),
    ).toBe("First line\nSecond line\n\nThird");
  });
});

describe("TextExtractor", () => {
  test("returns one chunk for a small text file", async () => {
    const path = tempPath("notes.txt");
    writeFileSync(path, "Alpha paragraph.\n\nBeta paragraph.", "utf8");

    await expect(processText(path)).resolves.toEqual({
      pageCount: 1,
      chunks: [
        {
          page: 1,
          chunkIndex: 0,
          content: "Alpha paragraph.\n\nBeta paragraph.",
        },
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

    const result = await processText(path, 55, 22);

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks[1]?.content).toContain("Alpha sentence two.");
  });

  test("hard-splits an oversized line", async () => {
    const path = tempPath("line.txt");
    writeFileSync(path, "x".repeat(95), "utf8");

    const result = await processText(path, 30, 0);

    expect(result.chunks.map((chunk) => chunk.content)).toEqual([
      "x".repeat(30),
      "x".repeat(30),
      "x".repeat(30),
      "x".repeat(5),
    ]);
  });

  test("returns no chunks for an empty text file", async () => {
    const path = tempPath("empty.txt");
    writeFileSync(path, "", "utf8");

    await expect(processText(path)).resolves.toEqual({
      pageCount: 1,
      chunks: [],
    });
  });

  test("rejects invalid UTF-8", async () => {
    const path = tempPath("invalid.txt");
    writeFileSync(path, Buffer.from([0xc3, 0x28]));

    await expect(processTextEither(path)).resolves.toMatchObject({
      _tag: "Left",
      left: {
        _tag: "TextExtractionError",
        reason: "Plain text source must be valid UTF-8",
      },
    });
  });

  test("rejects oversized files before reading content", async () => {
    const path = tempPath("oversized.txt");
    writeFileSync(path, "x");
    truncateSync(path, MAX_TEXT_SOURCE_BYTES + 1);

    await expect(processTextEither(path)).resolves.toMatchObject({
      _tag: "Left",
      left: {
        _tag: "TextExtractionError",
        reason: expect.stringContaining("exceeds max size"),
      },
    });
  });
});
