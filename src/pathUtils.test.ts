import { describe, expect, test } from "vitest";
import { resolve } from "node:path";

import {
  getPathFilename,
  getPathSegments,
  resolveUserPath,
} from "./pathUtils.js";

describe("pathUtils", () => {
  test.each(["/tmp/docs/file.pdf", "C:\\tmp\\docs\\file.pdf"])(
    "extracts the filename from %s",
    (path) => {
      expect(getPathFilename(path)).toBe("file.pdf");
    },
  );

  test.each([
    ["/tmp/docs/ml/paper.pdf", "/tmp/docs", ["ml", "paper.pdf"]],
    [
      "C:\\Users\\tester\\Docs\\ML\\paper.pdf",
      "C:\\Users\\tester\\Docs",
      ["ML", "paper.pdf"],
    ],
  ])("extracts segments of %s relative to %s", (path, base, expected) => {
    expect(getPathSegments(path, base)).toEqual(expected);
  });

  test("resolves relative user paths against cwd", () => {
    const cwd = process.platform === "win32" ? "C:\\work" : "/work";
    expect(resolveUserPath("docs/file.pdf", cwd)).toBe(
      resolve(cwd, "docs/file.pdf"),
    );
  });
});
