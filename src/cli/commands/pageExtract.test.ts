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

const Console = {
  log: () => Effect.void,
  error: () => Effect.void,
};

/** Runs `page extract <docId> <selector>` as JSON against a stubbed library lookup. */
function runExtract(
  docId: string,
  selector: string,
  lookup: PageExtractLibrary["getWithSourceIdentity"],
) {
  return Effect.runPromise(
    Effect.either(
      runPageExtractCommand(
        ["page", "extract", docId, selector],
        "json",
        { getWithSourceIdentity: lookup },
        Console,
        {},
      ),
    ),
  );
}

describe("page extract command validation", () => {
  test("validates syntax and options before document lookup", async () => {
    const lookup = vi.fn(() => Effect.succeed(null));

    expect(await runExtract("exact-id", "1,", lookup)).toMatchObject({
      _tag: "Left",
      left: { code: "INVALID_PAGE_SELECTOR" },
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("rejects non-PDF documents after one exact-ID lookup", async () => {
    const lookup = vi.fn(() =>
      Effect.succeed({
        document: document("markdown"),
        sourceIdentity: { status: "missing" as const },
      }),
    );

    expect(await runExtract("exact-id", "1", lookup)).toMatchObject({
      _tag: "Left",
      left: { code: "UNSUPPORTED_FILE_TYPE" },
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith("exact-id");
  });

  test.each([
    [{ status: "missing" as const }, "SOURCE_IDENTITY_MISSING"],
    [{ status: "invalid" as const }, "SOURCE_IDENTITY_INVALID"],
  ])("rejects %j source identity", async (sourceIdentity, code) => {
    const lookup = () => Effect.succeed({ document: document(), sourceIdentity });

    expect(await runExtract("exact-id", "1", lookup)).toMatchObject({
      _tag: "Left",
      left: { code },
    });
  });

  test("rejects unsafe stored IDs before source identity checks", async () => {
    const unsafe = new Document({ ...document(), id: "../unsafe" });
    const lookup = () =>
      Effect.succeed({
        document: unsafe,
        sourceIdentity: { status: "missing" as const },
      });

    expect(await runExtract("../unsafe", "1", lookup)).toMatchObject({
      _tag: "Left",
      left: { code: "UNSAFE_DOCUMENT_ID" },
    });
  });
});
