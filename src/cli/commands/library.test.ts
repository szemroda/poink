import { describe, expect, test } from "vitest";
import { Document } from "../../types.js";
import { toDocumentSummary } from "./library.js";

describe("document list projection", () => {
  test("keeps browse fields and omits full document details", () => {
    const document = new Document({
      id: "doc-1",
      title: "Example",
      path: "C:\\private\\example.pdf",
      addedAt: new Date("2026-01-01T00:00:00.000Z"),
      pageCount: 42,
      sizeBytes: 123456,
      tags: ["ai"],
      fileType: "pdf",
      metadata: { internal: true },
    });

    expect(toDocumentSummary(document)).toEqual({
      id: "doc-1",
      title: "Example",
      pageCount: 42,
      tags: ["ai"],
      fileType: "pdf",
    });
  });
});
