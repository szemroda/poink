import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/testSetup.ts"],
    testTimeout: 30000,
  },
});
