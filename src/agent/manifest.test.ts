import { describe, expect, test } from "vitest";
import { renderHelp } from "./manifest.js";

describe("renderHelp", () => {
  test("advertises taxonomy tree separately from taxonomy list", () => {
    const help = renderHelp();

    expect(help).toContain("poink taxonomy list");
    expect(help).toContain("poink taxonomy tree [id]");
    expect(help).not.toContain("poink taxonomy list [--tree]");
  });
});
