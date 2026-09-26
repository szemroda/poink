import { afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDirWithRetries } from "./testUtils.js";
import { Config } from "./types.js";

const testConfigDir = mkdtempSync(join(tmpdir(), "poink-test-config-"));
const testConfigPath = join(testConfigDir, "config.json");
const originalPoinkConfig = process.env.POINK_CONFIG;

// An explicit POINK_CONFIG must exist, so seed it with defaults.
writeFileSync(testConfigPath, JSON.stringify(Config.Default), "utf-8");
process.env.POINK_CONFIG = testConfigPath;

afterAll(async () => {
  if (originalPoinkConfig === undefined) {
    delete process.env.POINK_CONFIG;
  } else {
    process.env.POINK_CONFIG = originalPoinkConfig;
  }

  await removeDirWithRetries(testConfigDir);
});
