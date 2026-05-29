#!/usr/bin/env node

export {
  buildCliAppLayer,
  buildCliAppLayer as createCliAppLayer,
  runCli,
} from "./cli/index.js";

export {
  assessDoctorHealth,
  assessWALHealth,
  type HealthCheck,
  type WALHealthResult,
} from "./cli/health.js";

export {
  getCheckpointInterval,
  parseArgs,
  shouldCheckpoint,
} from "./cli/runner.js";

export {
  assertURLDownloadAllowed,
  filenameFromURL,
  getDownloadTargetPath,
  hasMarkdownExtension,
  isPrivateNetworkAddress,
  looksLikeMarkdown,
  MARKDOWN_INDICATORS,
  parseDurationString,
  parseSizeString,
  readResponseBufferWithLimit,
  resolveURLDownloadOptions,
} from "./urlDownloads.js";

import { isMainModule, runMain } from "./cli/main.js";

if (isMainModule(import.meta.url, process.argv[1])) {
  runMain().catch(() => process.exit(1));
}
