import { afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDirWithRetries } from "./testUtils.js";

const testConfigDir = mkdtempSync(join(tmpdir(), "poink-test-config-"));
const originalPoinkConfig = process.env.POINK_CONFIG;

process.env.POINK_CONFIG = join(testConfigDir, "config.json");

afterAll(async () => {
  if (originalPoinkConfig === undefined) {
    delete process.env.POINK_CONFIG;
  } else {
    process.env.POINK_CONFIG = originalPoinkConfig;
  }

  await removeDirWithRetries(testConfigDir);
});
