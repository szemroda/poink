import { Effect, Console as EffectConsole } from "effect";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatHintBlock } from "../agent/format.js";
import type { CommandResult } from "../agent/hints.js";
import { generateHints, generateNextActions } from "../agent/hints.js";
import {
  DEFAULT_CLI_OUTPUT_FORMAT,
  OUTPUT_FORMATS,
  type LogLevel,
  type NextAction,
  type OutputFormat,
} from "../agent/protocol.js";
import { readFileText } from "../runtime.js";
import type { DocumentIngestionService } from "../services/DocumentIngestion.js";
import type { LibraryStoreService } from "../services/LibraryStore.js";
import type { SemanticLibraryService } from "../services/SemanticLibrary.js";
import type { Concept, TaxonomyService } from "../services/TaxonomyService.js";
import type { Config } from "../types.js";
import type { InvocationTiming } from "./timing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export let VERSION = "0.0.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"),
  ) as { version?: unknown };
  if (typeof pkg.version === "string") VERSION = pkg.version;
} catch {
  // Package metadata is optional in test and embedded contexts.
}

export type CliLibrary = LibraryStoreService &
  SemanticLibraryService &
  DocumentIngestionService;

export class CLIError extends Error {
  readonly _tag = "CLIError";
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function describeCliFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
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
  config?: Config;
  library?: CliLibrary;
};

export type CommandExecutionContext = {
  args: string[];
  options: Record<string, unknown>;
  globals: GlobalCLIOptions;
  command: string;
  format: OutputFormat;
  Console: {
    log: (message: string) => Effect.Effect<void>;
    error: (message: string) => Effect.Effect<void>;
  };
  library: CliLibrary;
  getLoadedLibraryStats: () => Effect.Effect<
    | {
        _tag: "Right";
        right: {
          documents: number;
          chunks: number;
          embeddings: number;
          libraryPath: string;
        };
      }
    | { _tag: "Left" }
  >;
};

export type CommandBodyOutput = {
  command?: string;
  resultPayload: unknown;
  agentResult: CommandResult | null;
};

function unavailableLibrary(): CliLibrary {
  return new Proxy({} as CliLibrary, {
    get(_target, property) {
      return () =>
        Effect.die(
          new Error(
            `Command family did not provide library operation ${String(property)}`,
          ),
        );
    },
  });
}

export function runCommandWithContext(
  args: string[],
  globals: GlobalCLIOptions,
  execute: (
    context: CommandExecutionContext,
  ) => Effect.Effect<CommandBodyOutput, unknown, unknown>,
  options: Record<string, unknown> = {},
) {
  return Effect.gen(function* () {
    const { format, verbose } = globals;
    globals.timing?.startCommand();
    const command = args[0] ?? "cli";
    const library = globals.library ?? unavailableLibrary();
    const Console = {
      log: (message: string) =>
        format === "text" ? EffectConsole.log(message) : Effect.void,
      error: (message: string) =>
        format === "text" ? EffectConsole.error(message) : Effect.void,
    };

    const output = yield* execute({
      args,
      options,
      globals,
      command,
      format,
      Console,
      library,
      getLoadedLibraryStats: () =>
        globals.library
          ? Effect.either(globals.library.stats())
          : Effect.succeed({ _tag: "Left" as const }),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globals.timing?.finishCommand();
        }),
      ),
    );

    let nextActions: NextAction[] | undefined;
    if (output.agentResult) {
      if (format === "text") {
        const hints = generateHints(output.agentResult);
        if (hints.length > 0) {
          const statsResult = globals.library
            ? yield* Effect.either(globals.library.stats())
            : { _tag: "Left" as const };
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

export function getCheckpointInterval(
  opts: Record<string, string | boolean>,
): number {
  const interval = opts["checkpoint-interval"];
  if (typeof interval !== "string") return 50;
  const parsed = Number.parseInt(interval, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 50 : parsed;
}

export function shouldCheckpoint(
  processedCount: number,
  interval: number,
): boolean {
  return processedCount > 0 && processedCount % interval === 0;
}

export function parseArgs(args: string[]) {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      result[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1);
      continue;
    }
    const rawKey = arg.slice(2);
    const negated = rawKey.startsWith("no-");
    const key = negated ? rawKey.slice(3) : rawKey;
    const next = args[index + 1];
    if (!negated && next && !next.startsWith("--")) {
      result[key] = next;
      index++;
    } else {
      result[key] = !negated;
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
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    flagArgs.push(arg);
    if (!arg.includes("=")) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        flagArgs.push(next);
        index++;
      }
    }
  }
  return { positionals, flagArgs };
}

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

export function extractEnrichmentPreview(
  path: string,
  options: {
    enrich: boolean;
    pdfExtractor: PreviewPDFExtractor;
    officeExtractor: PreviewOfficeExtractor;
  },
): Effect.Effect<string | undefined> {
  const trim = (content: string) =>
    content.length > ENRICHMENT_PREVIEW_MAX_CHARS
      ? content.slice(0, ENRICHMENT_PREVIEW_MAX_CHARS)
      : content;
  const extension = extname(path).toLowerCase();
  const fileType =
    extension === ".md" || extension === ".markdown"
      ? "markdown"
      : extension === ".pdf"
        ? "pdf"
        : extension === ".docx"
          ? "docx"
          : extension === ".odt" || extension === ".fodt"
            ? "odt"
            : "unknown";
  if (fileType === "markdown") {
    return Effect.either(Effect.promise(() => readFileText(path))).pipe(
      Effect.map((result) =>
        result._tag === "Right" ? trim(result.right) : undefined,
      ),
    );
  }
  if (!options.enrich) return Effect.as(Effect.void, undefined);
  if (fileType === "pdf") {
    return Effect.either(options.pdfExtractor.extract(path)).pipe(
      Effect.map((result) =>
        result._tag === "Right"
          ? trim(
              result.right.pages
                .slice(0, ENRICHMENT_PREVIEW_MAX_UNITS)
                .map((page) => page.text)
                .join("\n\n"),
            )
          : undefined,
      ),
    );
  }
  if (fileType === "docx" || fileType === "odt") {
    return Effect.either(options.officeExtractor.extract(path)).pipe(
      Effect.map((result) =>
        result._tag === "Right"
          ? trim(
              result.right.sections
                .slice(0, ENRICHMENT_PREVIEW_MAX_UNITS)
                .map((section) =>
                  section.heading
                    ? `${section.heading}\n\n${section.text}`
                    : section.text,
                )
                .join("\n\n"),
            )
          : undefined,
      ),
    );
  }
  return Effect.as(Effect.void, undefined);
}

type TaxonomyTreeNode = {
  concept: Concept;
  children: TaxonomyTreeNode[];
};

export function renderConceptTree(
  node: TaxonomyTreeNode,
  prefix = "",
  isLast = true,
): string[] {
  const lines = [`${prefix}${isLast ? "-- " : "|- "}${node.concept.prefLabel}`];
  const childPrefix = isLast ? "    " : "|  ";
  node.children.forEach((child, index) => {
    lines.push(
      ...renderConceptTree(
        child,
        prefix + childPrefix,
        index === node.children.length - 1,
      ),
    );
  });
  return lines;
}

export async function buildTreeStructure(
  taxonomy: TaxonomyService,
  rootId?: string,
): Promise<TaxonomyTreeNode[]> {
  const concepts = await Effect.runPromise(taxonomy.listConcepts());
  const conceptMap = new Map(concepts.map((concept) => [concept.id, concept]));
  const childrenMap = new Map<string, string[]>();
  const roots: string[] = [];
  for (const concept of concepts) {
    const broaders = await Effect.runPromise(taxonomy.getBroader(concept.id));
    if (broaders.length === 0) roots.push(concept.id);
    for (const broader of broaders) {
      const children = childrenMap.get(broader.id) ?? [];
      children.push(concept.id);
      childrenMap.set(broader.id, children);
    }
  }
  const buildNode = (id: string): TaxonomyTreeNode | null => {
    const concept = conceptMap.get(id);
    if (!concept) return null;
    return {
      concept,
      children: (childrenMap.get(id) ?? [])
        .map(buildNode)
        .filter((node): node is TaxonomyTreeNode => node !== null),
    };
  };
  const ids = rootId ? [rootId] : roots;
  return ids
    .map(buildNode)
    .filter((node): node is TaxonomyTreeNode => node !== null);
}

export function resolveConfiguredDefaultFormat(config: Config): OutputFormat {
  return config.cli.globalFlags.format ?? DEFAULT_CLI_OUTPUT_FORMAT;
}

export function parseServeCommandOptions(args: string[]): {
  host?: string;
  port?: number;
  authToken?: string;
} {
  const opts = parseArgs(args);
  const overrides: { host?: string; port?: number; authToken?: string } = {};
  if ("host" in opts) {
    if (typeof opts.host !== "string" || opts.host.length === 0) {
      throw new CLIError("INVALID_FLAG", "Invalid --host value");
    }
    overrides.host = opts.host;
  }
  if ("port" in opts) {
    const port =
      typeof opts.port === "string" ? Number.parseInt(opts.port, 10) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new CLIError(
        "INVALID_FLAG",
        "Invalid --port value (expected integer 1-65535)",
      );
    }
    overrides.port = port;
  }
  if ("auth-token" in opts) {
    if (
      typeof opts["auth-token"] !== "string" ||
      opts["auth-token"].length === 0
    ) {
      throw new CLIError("INVALID_FLAG", "Invalid --auth-token value");
    }
    overrides.authToken = opts["auth-token"];
  }
  return overrides;
}

export function isOutputFormat(value: unknown): value is OutputFormat {
  return (
    typeof value === "string" && OUTPUT_FORMATS.includes(value as OutputFormat)
  );
}

export function installOpenAICodexShutdownHandlers(): () => void {
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    removeHandlers();
    try {
      const { closeOpenAICodexProviderManager } =
        await import("../services/OpenAICodexProvider.js");
      await closeOpenAICodexProviderManager();
    } catch {
      // Ignore cleanup errors during signal shutdown.
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
