#!/usr/bin/env node

import { isMainModule, runMain } from "./cli/main.js";

function exitWithFailure(): never {
  process.exit(1);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runMain().catch(exitWithFailure);
}
