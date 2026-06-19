import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import { Document } from "../../types.js";
import {
  type PageExtractLibrary,
  runPageExtractCommand,
} from "./pageExtract.js";

function document(fileType: "pdf" | "markdown" = "pdf"): Document {
  return new Document({
    id: "exact-id",
    title: "Document",
    path: "missing.pdf",
    addedAt: new Date("2026-01-01T00:00:00.000Z"),
    pageCount: 1,
    sizeBytes: 1,
    tags: [],
    fileType,
  });
}

function libraryWithLookup(
  lookup: PageExtractLibrary["getWithSourceIdentity"],
): PageExtractLibrary {
  return {
    getWithSourceIdentity: lookup,
  };
}

const Console = {
  log: () => Effect.void,
  error: () => Effect.void,
};

describe("page extract command validation", () => {
  test("validates syntax and options before document lookup", async () => {
    const lookup = vi.fn(() => Effect.succeed(null));
    const result = await Effect.runPromise(
      Effect.either(
        runPageExtractCommand(
          ["page", "extract", "exact-id", "1,"],
          "json",
          libraryWithLookup(lookup),
          Console,
          {},
        ),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { code: "INVALID_PAGE_SELECTOR" },
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("performs exact source-identity lookup once", async () => {
    const lookup = vi.fn(() =>
      Effect.succeed({
        document: document("markdown"),
        sourceIdentity: { status: "missing" as const },
      }),
    );
    const result = await Effect.runPromise(
      Effect.either(
        runPageExtractCommand(
          ["page", "extract", "exact-id", "1"],
          "json",
          libraryWithLookup(lookup),
          Console,
          {},
        ),
      ),
    );

    expect(lookup).toHaveBeenCalledExactlyOnceWith("exact-id");
    expect(result).toMatchObject({
      _tag: "Left",
      left: { code: "UNSUPPORTED_FILE_TYPE" },
    });
  });

  test.each([
    [{ status: "missing" as const }, "SOURCE_IDENTITY_MISSING"],
    [{ status: "invalid" as const }, "SOURCE_IDENTITY_INVALID"],
  ])("rejects %s source identity", async (sourceIdentity, code) => {
    const lookup = vi.fn(() =>
      Effect.succeed({ document: document(), sourceIdentity }),
    );
    const result = await Effect.runPromise(
      Effect.either(
        runPageExtractCommand(
          ["page", "extract", "exact-id", "1"],
          "json",
          libraryWithLookup(lookup),
          Console,
          {},
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { code } });
  });

  test("rejects unsafe stored IDs before source identity checks", async () => {
    const unsafe = new Document({
      ...document(),
      id: "../unsafe",
    });
    const lookup = vi.fn(() =>
      Effect.succeed({
        document: unsafe,
        sourceIdentity: { status: "missing" as const },
      }),
    );
    const result = await Effect.runPromise(
      Effect.either(
        runPageExtractCommand(
          ["page", "extract", "../unsafe", "1"],
          "json",
          libraryWithLookup(lookup),
          Console,
          {},
        ),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: { code: "UNSAFE_DOCUMENT_ID" },
    });
  });
});
