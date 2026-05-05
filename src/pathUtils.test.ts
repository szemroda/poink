import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  getPathFilename,
  getPathSegments,
  resolveUserPath,
} from "./pathUtils.js";

describe("pathUtils", () => {
  test("extracts filename from POSIX paths", () => {
    expect(getPathFilename("/tmp/docs/file.pdf")).toBe("file.pdf");
  });

  test("extracts filename from Windows paths", () => {
    expect(getPathFilename("C:\\tmp\\docs\\file.pdf")).toBe("file.pdf");
  });

  test("extracts path segments relative to a POSIX base path", () => {
    expect(
      getPathSegments("/tmp/docs/ml/paper.pdf", "/tmp/docs")
    ).toEqual(["ml", "paper.pdf"]);
  });

  test("extracts path segments relative to a Windows base path", () => {
    expect(
      getPathSegments(
        "C:\\Users\\tester\\Docs\\ML\\paper.pdf",
        "C:\\Users\\tester\\Docs"
      )
    ).toEqual(["ML", "paper.pdf"]);
  });

  test("resolves relative user paths against cwd", () => {
    const cwd = process.platform === "win32" ? "C:\\work" : "/work";
    expect(resolveUserPath("docs/file.pdf", cwd)).toBe(
      resolve(cwd, "docs/file.pdf")
    );
  });
});
