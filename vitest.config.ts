import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/testSetup.ts"],
    testTimeout: 30000,
    // Lets removeDirWithRetries release file handles held by closed libSQL clients.
    execArgv: ["--expose-gc"],
  },
});
