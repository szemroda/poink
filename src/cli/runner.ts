import { Effect, Console as EffectConsole } from "effect";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatHintBlock } from "../agent/format.js";
import { generateHints, generateNextActions } from "../agent/hints.js";
import { describeError } from "../errors.js";
import {
  DEFAULT_CLI_OUTPUT_FORMAT,
  type LogLevel,
  type NextAction,
  type OutputFormat,
} from "../agent/protocol.js";
import { readFileText } from "../runtime.js";
import type { DocumentIngestionService } from "../services/DocumentIngestion.js";
import type { LibraryStoreService } from "../services/LibraryStore.js";
import type { SemanticLibraryService } from "../services/SemanticLibrary.js";
import type {
  DocumentWithSourceIdentity,
} from "../services/StorageRepositories.js";
import type { StorageError } from "../services/StorageRepositories.js";
import {
  isOfficeDetectedSourceType,
  type DetectedSourceType,
  type OfficeSourceFormat,
} from "../services/SourceFileType.js";
import type { Concept, TaxonomyService } from "../services/TaxonomyService.js";
import type { Config } from "../types.js";
import type {
  CliCommandOutput,
  CliConsole,
} from "./commands/types.js";
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
  DocumentIngestionService & {
    getWithSourceIdentity: (
      id: string,
    ) => Effect.Effect<DocumentWithSourceIdentity | null, StorageError>;
    listWithSourceIdentity: (
      tag?: string,
    ) => Effect.Effect<DocumentWithSourceIdentity[], StorageError>;
  };

type SourceIdentityLibrary = Pick<
  CliLibrary,
  "getWithSourceIdentity" | "listWithSourceIdentity"
>;

export type StoreCliLibrary = LibraryStoreService & SourceIdentityLibrary;
export type SearchCliLibrary = LibraryStoreService & SemanticLibraryService;
export type DiagnosticsCliLibrary = LibraryStoreService &
  Pick<DocumentIngestionService, "checkReady"> &
  SourceIdentityLibrary;

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
  return describeError(error);
}

export type GlobalCLIOptions<
  L extends Pick<CliLibrary, "stats"> = CliLibrary,
> = {
  format: OutputFormat;
  pretty: boolean;
  verbose: boolean;
  logLevel: LogLevel;
  signal?: AbortSignal;
  timing?: InvocationTiming;
  config?: Config;
  library?: L;
};

export type GlobalCLIOptionsWithLibrary<
  L extends Pick<CliLibrary, "stats"> = CliLibrary,
> = GlobalCLIOptions<L> & {
  library: L;
};

export type BaseCommandExecutionContext<
  L extends Pick<CliLibrary, "stats"> = CliLibrary,
> = {
  args: string[];
  globals: GlobalCLIOptions<L>;
  command: string;
  format: OutputFormat;
  Console: CliConsole;
};

export type CommandExecutionContext<
  L extends Pick<CliLibrary, "stats"> = CliLibrary,
> = Omit<BaseCommandExecutionContext<L>, "globals"> & {
  globals: GlobalCLIOptionsWithLibrary<L>;
  library: L;
};

export type CommandBodyOutput = CliCommandOutput & {
  command?: string;
};

export type CommandExecutionOutput = {
  command: string;
  result: unknown;
  nextActions?: NextAction[];
};

export function runCommandWithContext<
  L extends Pick<CliLibrary, "stats">,
  E,
  R,
>(
  args: string[],
  globals: GlobalCLIOptions<L>,
  execute: (
    context: BaseCommandExecutionContext<L>,
  ) => Effect.Effect<CommandBodyOutput, E, R>,
): Effect.Effect<CommandExecutionOutput, E, R> {
  return Effect.gen(function* () {
    const { format, verbose } = globals;
    globals.timing?.startCommand();
    const command = args[0] ?? "cli";
    const Console = {
      log: (message: string) =>
        format === "text" ? EffectConsole.log(message) : Effect.void,
      error: (message: string) =>
        format === "text" ? EffectConsole.error(message) : Effect.void,
    };

    const context: BaseCommandExecutionContext<L> = {
      args,
      globals,
      command,
      format,
      Console,
    };

    const output = yield* execute(context).pipe(
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
      result: output.resultPayload,
      nextActions,
    };
  });
}

export function runCommandWithLibraryContext<
  L extends Pick<CliLibrary, "stats">,
  E,
  R,
>(
  args: string[],
  globals: GlobalCLIOptionsWithLibrary<L>,
  execute: (
    context: CommandExecutionContext<L>,
  ) => Effect.Effect<CommandBodyOutput, E, R>,
): Effect.Effect<CommandExecutionOutput, E, R> {
  return runCommandWithContext(args, globals, (context) =>
    execute({
      ...context,
      globals,
      library: globals.library,
    }),
  );
}

type PreviewPDFExtractor = {
  extract: (
    path: string,
  ) => Effect.Effect<{ pages: Array<{ text: string }> }, unknown>;
};

type PreviewOfficeExtractor = {
  extract: (
    path: string,
    sourceFormat: OfficeSourceFormat,
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
    detected: DetectedSourceType;
    pdfExtractor: PreviewPDFExtractor;
    officeExtractor: PreviewOfficeExtractor;
  },
): Effect.Effect<string | undefined> {
  const trim = (content: string) =>
    content.length > ENRICHMENT_PREVIEW_MAX_CHARS
      ? content.slice(0, ENRICHMENT_PREVIEW_MAX_CHARS)
      : content;
  const noPreview = Effect.sync((): string | undefined => undefined);
  const { detected } = options;
  if (detected.fileType === "markdown" || detected.fileType === "txt") {
    return Effect.tryPromise(() => readFileText(path)).pipe(
      Effect.map(trim),
      Effect.catchAll(() => noPreview),
    );
  }
  if (!options.enrich) return noPreview;
  if (detected.fileType === "pdf") {
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
  if (isOfficeDetectedSourceType(detected)) {
    return Effect.either(
      options.officeExtractor.extract(path, detected.sourceFormat),
    ).pipe(
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

export function buildTreeStructure(
  taxonomy: TaxonomyService,
  rootId?: string,
) {
  return Effect.gen(function* () {
    const concepts = yield* taxonomy.listConcepts();
    const broaderEntries = yield* Effect.forEach(
      concepts,
      (concept) =>
        taxonomy.getBroader(concept.id).pipe(
          Effect.map((broaders) => [concept.id, broaders] as const),
        ),
      { concurrency: 8 },
    );
    const conceptMap = new Map(
      concepts.map((concept) => [concept.id, concept]),
    );
    const childrenMap = new Map<string, string[]>();
    const roots: string[] = [];

    for (const [conceptId, broaders] of broaderEntries) {
      if (broaders.length === 0) roots.push(conceptId);
      for (const broader of broaders) {
        const children = childrenMap.get(broader.id) ?? [];
        children.push(conceptId);
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
  });
}

export function resolveConfiguredDefaultFormat(config: Config): OutputFormat {
  return config.cli.globalFlags.format ?? DEFAULT_CLI_OUTPUT_FORMAT;
}
