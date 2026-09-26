#!/usr/bin/env node

import { isMainModule, runMain } from "./cli/main.js";

if (isMainModule(import.meta.url, process.argv[1])) {
  runMain().catch(() => {
    process.exitCode = 1;
  });
}
