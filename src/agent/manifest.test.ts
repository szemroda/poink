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
});
