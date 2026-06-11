/**
 * Poink CLI
 */

import { Effect, Console as EffectConsole, JSONSchema, Layer, Logger } from "effect";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import { basename, extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  renderIngestProgress,
  createInitialState,
  type FileStatus,
  type IngestState,
} from "./ingestProgress.js";
import {
  AutoTagger,
  AutoTaggerLive,
  type EnrichmentResult,
} from "../services/AutoTagger.js";
import { PDFExtractor, PDFExtractorLive } from "../services/PDFExtractor.js";
import { OfficeExtractor, OfficeExtractorLive } from "../services/OfficeExtractor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export let VERSION = "0.0.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")
  );
  VERSION = pkg.version;
} catch {
  // Fallback for test or tooling contexts where package metadata is unavailable.
  VERSION = "0.0.0";
}
import {
  PDFLibrary,
  makePDFLibraryLive,
  SearchOptions,
  AddOptions,
  LibraryConfig,
} from "../index.js";
import {
  Document,
  PDFChunk,
  SearchResult,
  loadConfig,
  resolveVisualsConfig,
  resolveConfigPath,
} from "../types.js";
import { resolveUserPath } from "../pathUtils.js";
import { assessDocChunker } from "../chunking.js";
import {
  TaxonomyService,
  TaxonomyServiceImpl,
  type TaxonomyJSON,
  type Concept,
} from "../services/TaxonomyService.js";
import {
  EmbeddingProvider,
  EmbeddingProviderFullLive,
} from "../services/EmbeddingProvider.js";
import {
  checkOpenAICodexRuntime,
  closeOpenAICodexProviderManager,
  type OpenAICodexRuntimeStatus,
} from "../services/OpenAICodexProvider.js";
import { type CommandResult, generateHints, generateNextActions } from "../agent/hints.js";
import { formatHintBlock } from "../agent/format.js";
import { renderHelp } from "../agent/manifest.js";
import {
  DEFAULT_CLI_OUTPUT_FORMAT,
  DEFAULT_SERVER_CONFIG,
  OUTPUT_FORMATS,
  type LogLevel,
  type NextAction,
  type OutputFormat,
} from "../agent/protocol.js";
import { getLogLevel, toEffectLogLevel } from "../logger.js";
import { readFileText } from "../runtime.js";
import {
  downloadFile,
  fileTypeFromExtension,
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
  assertURLDownloadAllowed,
  type ResolvedURLDownloadOptions,
} from "../urlDownloads.js";
import { CONFIG_JSON_SCHEMA } from "./configValues.js";
import { runConfigCommand } from "./commands/config.js";
import { runLibraryCommand } from "./commands/library.js";
import { runProvidersCommand } from "./commands/providers.js";
import type { InvocationTiming } from "./timing.js";

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
};

/**
 * Check if a string is a URL
 */
export function isURL(str: string): boolean {
  return str.startsWith("http://") || str.startsWith("https://");
}

export const DOCUMENT_TITLE_EXTENSION_RE = /\.(pdf|md|markdown|docx|odt|fodt)$/i;

type PreviewPDFExtractor = {
  extract: (
    path: string,
  ) => Effect.Effect<{ pages: Array<{ text: string }> }, unknown>;
};

type PreviewOfficeExtractor = {
  extract: (
    path: string,
  ) => Effect.Effect<
    { sections: Array<{ heading: string; text: string }> },
    unknown
  >;
};

const ENRICHMENT_PREVIEW_MAX_CHARS = 8000;
const ENRICHMENT_PREVIEW_MAX_UNITS = 10;

function trimPreview(content: string): string {
  return content.length > ENRICHMENT_PREVIEW_MAX_CHARS
    ? content.slice(0, ENRICHMENT_PREVIEW_MAX_CHARS)
    : content;
}

function sectionsToPreview(
  sections: Array<{ heading: string; text: string }>,
): string {
  return sections
    .slice(0, ENRICHMENT_PREVIEW_MAX_UNITS)
    .map((section) =>
      section.heading ? `${section.heading}\n\n${section.text}` : section.text,
    )
    .join("\n\n");
}

export function extractEnrichmentPreview(
  path: string,
  options: {
    enrich: boolean;
    pdfExtractor: PreviewPDFExtractor;
    officeExtractor: PreviewOfficeExtractor;
  },
): Effect.Effect<string | undefined, never> {
  const fileType = fileTypeFromExtension(extname(path));

  if (fileType === "markdown") {
    return Effect.either(Effect.promise(() => readFileText(path))).pipe(
      Effect.map((result) =>
        result._tag === "Right" ? trimPreview(result.right) : undefined,
      ),
    );
  }

  if (!options.enrich) {
    return Effect.succeed(undefined);
  }

  if (fileType === "pdf") {
    return Effect.either(options.pdfExtractor.extract(path)).pipe(
      Effect.map((result) => {
        if (result._tag === "Left") return undefined;
        return trimPreview(
          result.right.pages
            .slice(0, ENRICHMENT_PREVIEW_MAX_UNITS)
            .map((page) => page.text)
            .join("\n\n"),
        );
      }),
    );
  }

  if (fileType === "docx" || fileType === "odt") {
    return Effect.either(options.officeExtractor.extract(path)).pipe(
      Effect.map((result) =>
        result._tag === "Right"
          ? trimPreview(sectionsToPreview(result.right.sections))
          : undefined,
      ),
    );
  }

  return Effect.succeed(undefined);
}

/**
 * WAL health assessment result
 */
export interface WALHealthResult {
  healthy: boolean;
  warnings: string[];
}

/**
 * Assess WAL health based on file count and total size
 * Thresholds: 50 files OR 50 MB
 */
export function assessWALHealth(stats: {
  fileCount: number;
  totalSizeBytes: number;
}): WALHealthResult {
  const warnings: string[] = [];
  const FILE_COUNT_THRESHOLD = 50;
  const SIZE_THRESHOLD_MB = 50;
  const SIZE_THRESHOLD_BYTES = SIZE_THRESHOLD_MB * 1024 * 1024;

  if (stats.fileCount > FILE_COUNT_THRESHOLD) {
    warnings.push(
      `WAL file count (${stats.fileCount}) exceeds recommended threshold (${FILE_COUNT_THRESHOLD})`
    );
  }

  const sizeMB = stats.totalSizeBytes / (1024 * 1024);
  if (stats.totalSizeBytes > SIZE_THRESHOLD_BYTES) {
    warnings.push(
      `WAL size (${sizeMB.toFixed(
        1
      )} MB) exceeds recommended threshold (${SIZE_THRESHOLD_MB} MB)`
    );
  }

  return {
    healthy: warnings.length === 0,
    warnings,
  };
}

function ensureLibraryDirectoryExists(config: LibraryConfig): void {
  if (!existsSync(config.libraryPath)) {
    mkdirSync(config.libraryPath, { recursive: true });
  }
}

/**
 * Overall doctor health assessment result
 */
export interface DoctorHealthResult {
  healthy: boolean;
  checks: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  healthy: boolean;
  /**
   * Optional severity for agent decision-making.
   * - ok: no action needed
   * - warning: non-fatal; action recommended
   * - error: action needed (doctor overall unhealthy)
   */
  severity?: "ok" | "warning" | "error";
  details?: string;
}

/**
 * Assess overall doctor health from individual checks
 */
export function assessDoctorHealth(data: {
  walHealth: WALHealthResult;
  ollamaReachable: boolean;
  orphanedData: { chunks: number; embeddings: number };
  chunker: { missing: number; mismatch: number };
}): DoctorHealthResult {
  const checks: HealthCheck[] = [];

  // WAL health check
  checks.push({
    name: "WAL Files",
    healthy: data.walHealth.healthy,
    severity: data.walHealth.healthy ? "ok" : "error",
    details:
      data.walHealth.warnings.length > 0
        ? data.walHealth.warnings.join("; ")
        : undefined,
  });

  // Ollama check
  checks.push({
    name: "Ollama",
    healthy: data.ollamaReachable,
    severity: data.ollamaReachable ? "ok" : "error",
    details: data.ollamaReachable ? undefined : "Unreachable",
  });

  // Orphaned data check
  const hasOrphans =
    data.orphanedData.chunks > 0 || data.orphanedData.embeddings > 0;
  checks.push({
    name: "Orphaned Data",
    healthy: !hasOrphans,
    severity: !hasOrphans ? "ok" : "error",
    details: hasOrphans
      ? `${data.orphanedData.chunks} chunks, ${data.orphanedData.embeddings} embeddings`
      : undefined,
  });

  // Chunker metadata check (affects result quality + reproducibility).
  // - Missing metadata means "unknown" (warning): we can't prove which chunker produced the chunks.
  // - Mismatched metadata means "definitely stale" (error): the chunker/config differs from current.
  const hasMismatch = data.chunker.mismatch > 0;
  const hasMissing = data.chunker.missing > 0;
  checks.push({
    name: "Chunker Metadata",
    healthy: !hasMismatch,
    severity: hasMismatch ? "error" : hasMissing ? "warning" : "ok",
    details:
      hasMismatch || hasMissing
        ? [
            hasMismatch
              ? `${data.chunker.mismatch} document(s) have mismatched chunker metadata`
              : null,
            hasMissing
              ? `${data.chunker.missing} document(s) are missing chunker metadata (unknown; consider rechunking)`
              : null,
          ]
            .filter(Boolean)
            .join("; ")
        : undefined,
  });

  return {
    healthy: checks.every((c) => c.healthy),
    checks,
  };
}

function healthCheckSeverity(check: HealthCheck): "ok" | "warning" | "error" {
  return check.severity ?? (check.healthy ? "ok" : "error");
}

function hasDoctorWarnings(checks: HealthCheck[]): boolean {
  return checks.some((check) => healthCheckSeverity(check) === "warning");
}

function renderDoctorCheckLines(checks: HealthCheck[]): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    const severity = healthCheckSeverity(check);
    const icon = severity === "ok" ? "OK" : severity === "warning" ? "!" : "FAIL";
    const status = severity === "ok" ? "ok" : severity === "warning" ? "WARNING" : "ISSUE";
    lines.push(`${icon} ${check.name}: ${status}`);
    if (check.details) {
      lines.push(`  ${check.details}`);
    }
  }
  return lines;
}

function buildOpenAICodexHealthCheck(
  status: OpenAICodexRuntimeStatus,
): HealthCheck | null {
  if (!status.configured) return null;

  const healthy = status.canStart && status.authenticated;
  return {
    name: "OpenAI Codex",
    healthy,
    severity: healthy ? "ok" : "error",
    details: [
      `configured for ${status.roles.join(", ")}`,
      "bundled Codex runtime",
      status.error ?? null,
    ]
      .filter(Boolean)
      .join("; "),
  };
}

/**
 * Build a hierarchy tree from concepts
 * Returns Map of conceptId -> { concept, children }
 */
interface TreeNode {
  concept: Concept;
  children: TreeNode[];
}

/**
 * Render a concept tree with box-drawing characters
 */
export function renderConceptTree(
  node: TreeNode,
  prefix = "",
  isLast = true
): string[] {
  const lines: string[] = [];
  const connector = isLast ? "-- " : "|- ";
  const childPrefix = isLast ? "    " : "|  ";

  lines.push(prefix + connector + node.concept.prefLabel);

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const childIsLast = i === node.children.length - 1;
    lines.push(...renderConceptTree(child, prefix + childPrefix, childIsLast));
  }

  return lines;
}

/**
 * Build tree structure from flat list of concepts with hierarchy
 */
export async function buildTreeStructure(
  taxonomy: TaxonomyService,
  rootId?: string
): Promise<TreeNode[]> {
  const concepts = await Effect.runPromise(taxonomy.listConcepts());
  const conceptMap = new Map(concepts.map((c) => [c.id, c]));

  // Build parent-child relationships
  const childrenMap = new Map<string, string[]>();
  const roots: string[] = [];

  for (const concept of concepts) {
    const broaders = await Effect.runPromise(taxonomy.getBroader(concept.id));
    if (broaders.length === 0) {
      roots.push(concept.id);
    } else {
      for (const broader of broaders) {
        if (!childrenMap.has(broader.id)) {
          childrenMap.set(broader.id, []);
        }
        childrenMap.get(broader.id)!.push(concept.id);
      }
    }
  }

  // Build tree nodes recursively
  const buildNode = (conceptId: string): TreeNode | null => {
    const concept = conceptMap.get(conceptId);
    if (!concept) return null;

    const childIds = childrenMap.get(conceptId) || [];
    const children = childIds
      .map(buildNode)
      .filter((n): n is TreeNode => n !== null);

    return { concept, children };
  };

  // If rootId specified, build from that node
  if (rootId) {
    const node = buildNode(rootId);
    return node ? [node] : [];
  }

  // Otherwise, build all root nodes
  return roots.map(buildNode).filter((n): n is TreeNode => n !== null);
}

/**
 * Get checkpoint interval from CLI options
 * Default is 50 documents
 */
export function getCheckpointInterval(
  opts: Record<string, string | boolean>
): number {
  const interval = opts["checkpoint-interval"];
  if (typeof interval === "string") {
    const parsed = parseInt(interval, 10);
    return isNaN(parsed) || parsed <= 0 ? 50 : parsed;
  }
  return 50; // Default
}

/**
 * Determine if checkpoint should be triggered at this document count
 * Checkpoints at every N documents (e.g., 50, 100, 150...)
 */
export function shouldCheckpoint(
  processedCount: number,
  interval: number
): boolean {
  return processedCount > 0 && processedCount % interval === 0;
}

export function parseArgs(args: string[]) {
  const result: Record<string, string | boolean> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const value = arg.slice(eq + 1);
        result[key] = value;
        i += 1;
        continue;
      }

      const rawKey = arg.slice(2);
      const isNegatedBoolean = rawKey.startsWith("no-");
      const key = isNegatedBoolean ? rawKey.slice("no-".length) : rawKey;
      const next = args[i + 1];
      if (!isNegatedBoolean && next && !next.startsWith("--")) {
        result[key] = next;
        i += 2;
      } else {
        result[key] = isNegatedBoolean ? false : true;
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return result;
}

function parseServeFlagArgs(args: string[]) {
  const result: Record<string, string | boolean> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        result[arg.slice(2, eq)] = arg.slice(eq + 1);
        i += 1;
        continue;
      }

      const rawKey = arg.slice(2);
      const isNegatedBoolean = rawKey.startsWith("no-");
      const key = isNegatedBoolean ? rawKey.slice("no-".length) : rawKey;
      const next = args[i + 1];
      if (!isNegatedBoolean && next && !next.startsWith("--")) {
        result[key] = next;
        i += 2;
      } else {
        result[key] = isNegatedBoolean ? false : true;
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return result;
}

export function splitPositionalsAndFlags(args: string[]): {
  positionals: string[];
  flagArgs: string[];
} {
  const positionals: string[] = [];
  const flagArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      flagArgs.push(arg);
      const hasEq = arg.includes("=");
      if (!hasEq) {
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flagArgs.push(next);
          i++;
        }
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flagArgs };
}

export class CLIError extends Error {
  readonly _tag = "CLIError";
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export function describeCliFailure(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export type GlobalCLIOptions = {
  format: OutputFormat;
  configuredDefaultFormat: OutputFormat;
  pretty: boolean;
  verbose: boolean;
  logLevel: LogLevel;
  timing?: InvocationTiming;
};

export type CommandExecutionContext = {
  args: string[];
  options: Record<string, unknown>;
  globals: GlobalCLIOptions;
  command: string;
  format: OutputFormat;
  Console: {
    log: (message: string) => Effect.Effect<void, never, never>;
    error: (message: string) => Effect.Effect<void, never, never>;
  };
  library: PDFLibrary;
  getLoadedLibraryStats: () => Effect.Effect<
    { _tag: "Right"; right: Awaited<ReturnType<PDFLibrary["stats"]> extends Effect.Effect<infer A, any, any> ? A : never> } | { _tag: "Left" },
    never,
    never
  >;
};

export type CommandBodyOutput = {
  command?: string;
  resultPayload: unknown;
  agentResult: CommandResult | null;
};

export function runCommandWithContext(
  args: string[],
  globals: GlobalCLIOptions,
  execute: (
    context: CommandExecutionContext,
  ) => Effect.Effect<CommandBodyOutput, unknown, any>,
  options: Record<string, unknown> = {},
) {
  return Effect.gen(function* () {
    const { format, verbose } = globals;
    globals.timing?.startCommand();
    const command = args[0] ?? "cli";
    let loadedLibrary: PDFLibrary | undefined;

    const Console = {
      log: (message: string) =>
        format === "text" ? EffectConsole.log(message) : Effect.void,
      error: (message: string) =>
        format === "text" ? EffectConsole.error(message) : Effect.void,
    };
    const library = new Proxy({} as PDFLibrary, {
      get(_target, prop, receiver) {
        return (...callArgs: unknown[]) =>
          Effect.flatMap(
            Effect.gen(function* () {
              if (loadedLibrary) return loadedLibrary;
              loadedLibrary = yield* PDFLibrary;
              return loadedLibrary;
            }),
            (service) => {
              const value = Reflect.get(service as object, prop, receiver);
              if (typeof value !== "function") {
                return value;
              }
              return value.apply(service, callArgs);
            },
          );
      },
    });

    const output = yield* execute({
      args,
      options,
      globals,
      command,
      format,
      Console,
      library,
      getLoadedLibraryStats: () =>
        loadedLibrary
          ? Effect.either(loadedLibrary.stats()) as Effect.Effect<any, never, never>
          : Effect.succeed({ _tag: "Left" as const }),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globals.timing?.finishCommand();
        }),
      ),
    );

    let nextActions: NextAction[] | undefined = undefined;
    if (output.agentResult) {
      if (format === "text") {
        const hints = generateHints(output.agentResult);
        if (hints.length > 0) {
          const statsResult = yield* (loadedLibrary
            ? Effect.either(loadedLibrary.stats())
            : Effect.succeed({ _tag: "Left" as const }));
          const statsData =
            statsResult._tag === "Right"
              ? { documents: statsResult.right.documents }
              : undefined;
          yield* Console.log(formatHintBlock(hints, statsData));
        }
      } else if (verbose) {
        nextActions = generateNextActions(output.agentResult);
      }
    }

    return {
      command: output.command ?? command,
      result: output.resultPayload ?? output.agentResult,
      agentResult: output.agentResult,
      nextActions,
    };
  });
}

type ServeCommandOverrides = {
  host?: string;
  port?: number;
  authToken?: string;
};

function isOutputFormat(value: unknown): value is OutputFormat {
  return (
    typeof value === "string" &&
    OUTPUT_FORMATS.includes(value as OutputFormat)
  );
}

function parseGlobalCLIOptions(
  rawArgs: string[],
  configuredDefaultFormat: OutputFormat = DEFAULT_CLI_OUTPUT_FORMAT,
): {
  options: GlobalCLIOptions;
  args: string[];
} {
  let format: OutputFormat = configuredDefaultFormat;
  let pretty = false;
  let verbose = false;
  let logLevel: LogLevel = getLogLevel();

  const args: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === "--pretty") {
      pretty = true;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "--format" || arg.startsWith("--format=")) {
      const value =
        arg === "--format" ? rawArgs[i + 1] : arg.split("=", 2)[1];
      if (arg === "--format") i++;

      if (isOutputFormat(value)) {
        format = value;
        continue;
      }

      throw new CLIError(
        "INVALID_FLAG",
        `Invalid --format value: ${String(value)}`,
        { flag: "--format", value }
      );
    }

    if (arg === "--log-level" || arg.startsWith("--log-level=")) {
      const value =
        arg === "--log-level" ? rawArgs[i + 1] : arg.split("=", 2)[1];
      if (arg === "--log-level") i++;

      if (
        value === "silent" ||
        value === "error" ||
        value === "info" ||
        value === "debug"
      ) {
        logLevel = value;
        continue;
      }

      throw new CLIError(
        "INVALID_FLAG",
        `Invalid --log-level value: ${String(value)}`,
        { flag: "--log-level", value }
      );
    }

    args.push(arg);
  }

  return {
    options: {
      format,
      configuredDefaultFormat,
      pretty,
      verbose,
      logLevel,
    },
    args,
  };
}

export function resolveConfiguredDefaultFormat(): OutputFormat {
  try {
    return loadConfig().cli.globalFlags.format;
  } catch {
    return DEFAULT_CLI_OUTPUT_FORMAT;
  }
}

export function parseServeCommandOptions(args: string[]): ServeCommandOverrides {
  const opts = parseServeFlagArgs(args);
  const overrides: ServeCommandOverrides = {};

  if ("host" in opts) {
    if (typeof opts.host !== "string" || opts.host.length === 0) {
      throw new CLIError(
        "INVALID_FLAG",
        "Invalid --host value (expected non-empty string)",
        { flag: "--host", value: opts.host }
      );
    }
    overrides.host = opts.host;
  }

  if ("port" in opts) {
    if (typeof opts.port !== "string") {
      throw new CLIError(
        "INVALID_FLAG",
        "Invalid --port value (expected integer 1-65535)",
        { flag: "--port", value: opts.port }
      );
    }
    const parsedPort = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new CLIError(
        "INVALID_FLAG",
        "Invalid --port value (expected integer 1-65535)",
        { flag: "--port", value: opts.port }
      );
    }
    overrides.port = parsedPort;
  }

  if ("auth-token" in opts) {
    if (typeof opts["auth-token"] !== "string" || opts["auth-token"].length === 0) {
      throw new CLIError(
        "INVALID_FLAG",
        "Invalid --auth-token value (expected non-empty token)",
        { flag: "--auth-token", value: opts["auth-token"] }
      );
    }
    overrides.authToken = opts["auth-token"];
  }

  return overrides;
}

// ============================================================================
// Graceful Shutdown Handlers
// ============================================================================
// MCP tool invocations are separate processes that may not cleanly close the
// database. Register handlers early to ensure CHECKPOINT runs before exit.

export function installOpenAICodexShutdownHandlers(): () => void {
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    removeHandlers();
    try {
      await closeOpenAICodexProviderManager();
    } catch {
      // ignore cleanup errors during signal shutdown
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const removeHandlers = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return removeHandlers;
}
