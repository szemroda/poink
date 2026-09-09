import { describe, expect, test } from "vitest";
import { renderHelp } from "./manifest.js";

describe("renderHelp", () => {
  test("advertises command-scoped config override", () => {
    const help = renderHelp();

    expect(help).toContain("--config <path>");
    expect(help).toContain("place after command name");
  });

  test("advertises taxonomy tree separately from taxonomy list", () => {
    const help = renderHelp();

    expect(help).toContain("poink taxonomy list");
    expect(help).toContain("poink taxonomy tree [id]");
    expect(help).not.toContain("poink taxonomy list [--tree]");
  });

  test("documents the ingest glob base", () => {
    const help = renderHelp();

    expect(help).toContain("[--include <glob>] [--exclude <glob>]");
    expect(help).toContain(
      "Ingest globs match paths relative to the working directory.",
    );
  });
});
