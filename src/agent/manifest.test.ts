import { describe, expect, test } from "vitest";
import { renderHelp } from "./manifest.js";

describe("renderHelp", () => {
  test.each([
    ["the command-scoped config override", "--config <path>       use this config file for one command; place after command name"],
    ["output formats with the default marked", "--format <mode>       text (default), json, ndjson"],
    ["taxonomy tree as its own command", "poink taxonomy tree [id]"],
    ["the ingest glob base", "Ingest globs match paths relative to the working directory."],
  ])("documents %s", (_name, line) => {
    expect(renderHelp()).toContain(line);
  });
});
