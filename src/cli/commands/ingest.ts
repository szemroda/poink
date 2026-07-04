import { Effect } from "effect";
import { basename } from "path";
import { existsSync, statSync } from "fs";
import { AddOptions, resolveVisualsConfig } from "../../types.js";
import { resolveUserPath } from "../../pathUtils.js";
import {
  AutoTagger,
  type EnrichmentResult,
} from "../../services/AutoTagger.js";
import { PDFExtractor } from "../../services/PDFExtractor.js";
import { OfficeExtractor } from "../../services/OfficeExtractor.js";
import {
  fingerprintSource,
  type SourceFingerprint,
} from "../../services/SourceIntegrity.js";
import {
  SourceFileTypeDetector,
  type DetectedSourceType,
} from "../../services/SourceFileType.js";
import {
  createInitialState,
  renderIngestProgress,
  type FileStatus,
} from "../ingestProgress.js";
import { shouldCheckpoint } from "../args.js";
import {
  CLIError,
  extractEnrichmentPreview,
  runCommandWithContext,
  type CommandExecutionContext,
  type GlobalCLIOptions,
} from "../runner.js";
import {
  combineIngestDiscoveryResults,
  discoverIngestFiles,
  globPatternsFromOption,
  withSampledSelection,
  type IngestDiscoveryResult,
  type IngestSelectionFilters,
  type IngestSelectionSummary,
} from "../fileDiscovery.js";

interface IngestCommandOptions extends Record<string, unknown> {
  enrich?: boolean;
  visuals?: boolean;
  "auto-tag"?: boolean;
  tags?: string;
  sample?: string | number;
  include?: string | string[];
  exclude?: string | string[];
  recursive?: boolean;
  "no-recursive"?: boolean;
  progress?: boolean;
}

type CliConsole = CommandExecutionContext["Console"];

type IngestSettings = {
  autoTag: boolean;
  enrich: boolean;
  manualTags: string[] | undefined;
  basePath: string;
};

type DocumentMetadata = {
  title: string | undefined;
  tags: string[];
  enrichment: EnrichmentResult | undefined;
};

type PreparedSourceContext = {
  initialFingerprint: SourceFingerprint;
  detectedType: DetectedSourceType;
};

type PreparedIngestDocument = {
  source: PreparedSourceContext;
  metadata: DocumentMetadata;
};

type IngestResultPayload = {
  mode: "line-progress" | "simple";
  totalPlanned: number;
  skippedExisting: number;
  processed: number;
  succeeded: number;
  failed: number;
  enrich: boolean;
  visuals: boolean;
  autoTag: boolean;
  manualTags: string[] | null;
  selection: IngestSelectionSummary;
};

type IngestEarlyResultPayload = {
  foundFiles: number;
  skippedExisting: number;
  processed: number;
  succeeded: number;
  failed: number;
  selection: IngestSelectionSummary;
};

const CHECKPOINT_INTERVAL = 1;

function parseDirectories(args: string[]): string[] {
  const directories: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (!argument || argument.startsWith("--")) break;
    directories.push(argument);
  }
  return directories;
}

function parseManualTags(tags: string | undefined): string[] | undefined {
  if (!tags) return undefined;
  return tags.split(",").map((tag) => tag.trim());
}

function parseSampleSize(
  sample: string | number | undefined,
): number | undefined {
  if (!sample) return undefined;
  return parseInt(String(sample), 10);
}

function selectionFiltersFromOptions(
  options: IngestCommandOptions,
): IngestSelectionFilters {
  return {
    include: globPatternsFromOption(options.include),
    exclude: globPatternsFromOption(options.exclude),
  };
}

function resolveTargetDirectories(directories: string[], Console: CliConsole) {
  return Effect.gen(function* () {
    const targetDirectories: string[] = [];

    for (const directory of directories) {
      const targetDirectory = resolveUserPath(directory);
      if (!existsSync(targetDirectory)) {
        yield* Console.error(`Error: Directory not found: ${targetDirectory}`);
        return yield* Effect.fail(
          new CLIError("NOT_FOUND", `Directory not found: ${targetDirectory}`, {
            targetDir: targetDirectory,
          }),
        );
      }

      if (!statSync(targetDirectory).isDirectory()) {
        yield* Console.error(`Error: Not a directory: ${targetDirectory}`);
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", `Not a directory: ${targetDirectory}`, {
            targetDir: targetDirectory,
          }),
        );
      }

      targetDirectories.push(targetDirectory);
    }

    return targetDirectories;
  });
}

function prepareDocumentMetadata(
  filePath: string,
  detected: DetectedSourceType,
  settings: IngestSettings,
  onPreviewExtracted: (
    content: string | undefined,
  ) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const tags = settings.manualTags ? [...settings.manualTags] : [];
    if (!settings.autoTag && !settings.enrich) {
      return {
        title: undefined,
        tags,
        enrichment: undefined,
      } satisfies DocumentMetadata;
    }

    const tagger = yield* AutoTagger;
    const pdfExtractor = yield* PDFExtractor;
    const officeExtractor = yield* OfficeExtractor;
    const content = yield* extractEnrichmentPreview(filePath, {
      enrich: settings.enrich,
      detected,
      pdfExtractor,
      officeExtractor,
    });
    yield* onPreviewExtracted(content);

    if (settings.enrich && content) {
      const enrichment = yield* tagger.enrich(filePath, content, {
        basePath: settings.basePath,
      });
      return {
        title: enrichment.title,
        tags: [...tags, ...enrichment.tags],
        enrichment,
      } satisfies DocumentMetadata;
    }

    const tagResult = yield* tagger.generateTags(filePath, content, {
      heuristicsOnly: !content,
      basePath: settings.basePath,
    });
    return {
      title: undefined,
      tags: [...tags, ...tagResult.allTags],
      enrichment: undefined,
    } satisfies DocumentMetadata;
  });
}

function prepareIngestSource(
  filePath: string,
  settings: IngestSettings,
  onPreviewExtracted?: (content: string | undefined) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const fingerprint = yield* fingerprintSource(filePath);
    const detector = yield* SourceFileTypeDetector;
    const detected = yield* detector.detect(filePath);
    const metadata = yield* prepareDocumentMetadata(
      filePath,
      detected,
      settings,
      onPreviewExtracted,
    );
    return {
      source: {
        initialFingerprint: fingerprint,
        detectedType: detected,
      },
      metadata,
    } satisfies PreparedIngestDocument;
  });
}

function createAddOptions(
  prepared: PreparedIngestDocument,
  visualsEnabled: boolean,
  visualsMode: "explicit" | "config" | undefined,
): AddOptions {
  const { metadata } = prepared;
  return new AddOptions({
    title: metadata.title,
    tags: metadata.tags.length > 0 ? metadata.tags : undefined,
    visuals: visualsEnabled ? true : undefined,
    visualsMode,
    sourceContext: prepared.source,
  });
}

function createResultPayload(
  mode: IngestResultPayload["mode"],
  totalPlanned: number,
  skippedExisting: number,
  processed: number,
  failed: number,
  settings: IngestSettings,
  visualsEnabled: boolean,
  selection: IngestSelectionSummary,
): IngestResultPayload {
  return {
    mode,
    totalPlanned,
    skippedExisting,
    processed,
    succeeded: processed - failed,
    failed,
    enrich: settings.enrich,
    visuals: visualsEnabled,
    autoTag: settings.autoTag,
    manualTags: settings.manualTags ?? null,
    selection,
  };
}

function createEarlyResultPayload(
  foundFiles: number,
  skippedExisting: number,
  processed: number,
  failed: number,
  selection: IngestSelectionSummary,
): IngestEarlyResultPayload {
  return {
    foundFiles,
    skippedExisting,
    processed,
    succeeded: processed - failed,
    failed,
    selection,
  };
}

function renderSelectionSummary(selection: IngestSelectionSummary): string {
  return `Selection: discovered ${selection.discovered}, included ${selection.included}, excluded ${selection.excluded}, selected ${selection.selected}`;
}

function discoverTargetFiles(
  targetDirs: string[],
  selectionFilters: IngestSelectionFilters,
  recursive: boolean,
  Console: CliConsole,
) {
  return Effect.gen(function* () {
    yield* Console.log(
      `Scanning ${targetDirs.length} director${
        targetDirs.length > 1 ? "ies" : "y"
      }...`,
    );

    const discoveryResults: IngestDiscoveryResult[] = [];
    for (const dir of targetDirs) {
      const found = discoverIngestFiles(dir, selectionFilters, recursive);
      yield* Console.log(
        `  ${basename(dir)}: ${found.selection.discovered} files`,
      );
      discoveryResults.push(found);
    }

    const discovery = combineIngestDiscoveryResults(
      discoveryResults,
      selectionFilters,
    );
    yield* Console.log(`Total: ${discovery.selection.discovered} files`);
    yield* Console.log(renderSelectionSummary(discovery.selection));

    return discovery;
  });
}

function logEnrichmentDetails(Console: CliConsole, metadata: DocumentMetadata) {
  return Effect.gen(function* () {
    const enrichment = metadata.enrichment;
    if (!enrichment) return;

    yield* Console.log(`    Title: ${enrichment.title}`);
    if (enrichment.author) {
      yield* Console.log(`    Author: ${enrichment.author}`);
    }
    yield* Console.log(`    Type: ${enrichment.documentType}`);
    yield* Console.log(`    Tags: ${enrichment.tags.slice(0, 5).join(", ")}`);
    if (enrichment.concepts.length > 0) {
      yield* Console.log(
        `    Concepts: ${enrichment.concepts.slice(0, 3).join(", ")}`,
      );
    }
    if (enrichment.proposedConcepts?.length) {
      yield* Console.log(
        `    Proposed: ${enrichment.proposedConcepts
          .map((concept) => concept.prefLabel)
          .join(", ")}`,
      );
    }
  });
}

function acceptProposalsAfterCommit(
  Console: CliConsole,
  metadata: DocumentMetadata,
) {
  return Effect.gen(function* () {
    const proposals = metadata.enrichment?.proposedConcepts;
    if (!proposals?.length) return;

    const tagger = yield* AutoTagger;
    const result = yield* Effect.either(tagger.acceptProposals(proposals));
    if (result._tag === "Right") return;

    yield* Console.log(
      "    WARN Document added, but concept acceptance failed",
    );
  });
}

export function runIngestCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: IngestCommandOptions = {},
) {
  return runCommandWithContext(
    args,
    globals,
    ({ Console, format, library, globals }) =>
      Effect.gen(function* () {
        let resultPayload: unknown = null;
        const agentResult = null;
        const command = args[0];
        if (command !== "ingest") {
          return yield* Effect.fail(
            new CLIError(
              "UNKNOWN_COMMAND",
              `Unknown ingest command: ${command}`,
              { command },
            ),
          );
        }

        const directories = parseDirectories(args);
        if (directories.length === 0) {
          yield* Console.error("Error: At least one directory required");
          yield* Console.error(
            "Usage: poink ingest <dir1> [dir2] [dir3] [options]",
          );
          yield* Console.error("");
          yield* Console.error("Options:");
          yield* Console.error(
            "  --enrich       Full LLM enrichment (title, summary, concepts)",
          );
          yield* Console.error(
            "  --visuals      Describe embedded PDF/DOCX images as searchable chunks",
          );
          yield* Console.error(
            "  --auto-tag     Light tagging (heuristics + LLM)",
          );
          yield* Console.error("  --tags a,b,c   Manual tags for all files");
          yield* Console.error("  --sample N     Process only first N files");
          yield* Console.error("  --include GLOB Include matching paths");
          yield* Console.error("  --exclude GLOB Exclude matching paths");
          yield* Console.error("  --no-progress  Disable line progress output");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "At least one directory required", {
              command: "ingest",
              hint: "poink ingest ./docs --enrich",
            }),
          );
        }

        const targetDirs = yield* resolveTargetDirectories(
          directories,
          Console,
        );
        const recursive =
          options["no-recursive"] === true
            ? false
            : options.recursive !== false;
        const selectionFilters = selectionFiltersFromOptions(options);
        const manualTags = parseManualTags(options.tags);
        const sampleSize = parseSampleSize(options.sample);
        // Agent-only mode: progress writes to stdout and will break JSON parsing.
        // Only allow progress in explicit `--format text` mode.
        const useProgress = format === "text" && options.progress !== false;
        const autoTag = options["auto-tag"] === true;
        const enrich = options.enrich === true;
        const ingestConfig = globals.config!;
        const visualsExplicit = options.visuals === true;
        const visualsEnabled =
          visualsExplicit || resolveVisualsConfig(ingestConfig).enabled;
        const visualsMode = visualsEnabled
          ? visualsExplicit
            ? "explicit"
            : "config"
          : undefined;
        const settings: IngestSettings = {
          autoTag,
          enrich,
          manualTags,
          basePath: targetDirs[0],
        };

        const discovery = yield* discoverTargetFiles(
          targetDirs,
          selectionFilters,
          recursive,
          Console,
        );
        let files = discovery.files;
        let selection = discovery.selection;

        if (files.length === 0) {
          yield* Console.log("No supported document files found");
          return {
            resultPayload: createEarlyResultPayload(
              0,
              0,
              0,
              0,
              selection,
            ),
            agentResult,
          };
        }

        // Apply sample limit if specified
        if (sampleSize && sampleSize < files.length) {
          files = files.slice(0, sampleSize);
          selection = withSampledSelection(selection, files.length);
          yield* Console.log(`Processing sample of ${sampleSize} files`);
        }

        // Check what's already in the library to skip duplicates
        const existingDocs = yield* library.list();
        const existingPaths = new Set(existingDocs.map((d) => d.path));
        const newFiles = files.filter((f) => !existingPaths.has(f));
        const skippedExisting = files.length - newFiles.length;

        if (newFiles.length < files.length) {
          yield* Console.log(
            `Skipping ${skippedExisting} already-ingested files`,
          );
        }

        if (newFiles.length === 0) {
          yield* Console.log("All files already ingested");
          return {
            resultPayload: createEarlyResultPayload(
              files.length,
              skippedExisting,
              0,
              0,
              selection,
            ),
            agentResult,
          };
        }

        files = newFiles;

        // Check if we can use line progress (requires TTY)
        const canUseProgress =
          useProgress && process.stdout.isTTY && process.stdin.isTTY;
        if (useProgress && !canUseProgress) {
          yield* Console.log(
            "Progress disabled (not a TTY), using simple output",
          );
        }

        // Process files
        if (canUseProgress) {
          // Line progress mode
          const state = createInitialState();
          state.totalFiles = files.length;
          state.phase = "processing";

          const progress = renderIngestProgress(state);

          yield* Effect.gen(function* () {
            for (let i = 0; i < files.length; i++) {
              if (progress.isCancelled()) {
                progress.cleanup();
                yield* Console.log("\nIngestion cancelled by user");
                break;
              }

              const filePath = files[i];
              const filename = basename(filePath);

              const currentFile: FileStatus = {
                path: filePath,
                filename,
                status: "chunking",
              };

              progress.update({ currentFile });

              const fileResult = yield* Effect.either(
                Effect.gen(function* () {
                  const prepared = yield* prepareIngestSource(
                    filePath,
                    settings,
                    () =>
                      Effect.sync(() => {
                        currentFile.status = "embedding";
                        progress.update({ currentFile });
                      }),
                  );
                  const { metadata } = prepared;

                  // Add the file
                  const addOptions = createAddOptions(
                    prepared,
                    visualsEnabled,
                    visualsMode,
                  );
                  const doc = yield* library.add(
                    filePath,
                    addOptions,
                  );
                  yield* acceptProposalsAfterCommit(Console, metadata);

                  currentFile.status = "done";
                  currentFile.chunks = doc.pageCount;

                  progress.update({
                    processedFiles: i + 1,
                    currentFile,
                    recentFiles: [
                      ...progress.getState().recentFiles,
                      currentFile,
                    ],
                  });

                  // Checkpoint every N documents to prevent WAL accumulation
                  if (shouldCheckpoint(i + 1, CHECKPOINT_INTERVAL)) {
                    progress.update({
                      checkpointInProgress: true,
                      checkpointMessage: `Checkpointing WAL (${i + 1} docs)...`,
                    });

                    const checkpointResult = yield* Effect.either(
                      library.checkpoint(),
                    );

                    if (checkpointResult._tag === "Left") {
                      yield* Effect.logError(
                        `Warning: Checkpoint failed at ${i + 1} docs: ${
                          checkpointResult.left
                        }`,
                      );
                    }

                    progress.update({
                      checkpointInProgress: false,
                      checkpointMessage: undefined,
                      lastCheckpointAt: i + 1,
                    });
                  }
                }),
              );
              if (fileResult._tag === "Left") {
                currentFile.status = "error";
                currentFile.error = String(fileResult.left);

                progress.update({
                  processedFiles: i + 1,
                  currentFile,
                  recentFiles: [
                    ...progress.getState().recentFiles,
                    currentFile,
                  ],
                  errors: [...progress.getState().errors, currentFile],
                });
              }
            }

            progress.update({ phase: "done", endTime: Date.now() });

            // Wait a moment for user to see final state
            yield* Effect.sleep("2 seconds");
            progress.cleanup();

            const finalState = progress.getState();
            yield* Console.log(
              `\nOK Ingested ${
                finalState.processedFiles - finalState.errors.length
              } files`,
            );
            if (finalState.errors.length > 0) {
              yield* Console.log(
                `WARN ${finalState.errors.length} files failed`,
              );
            }

            const processed = finalState.processedFiles;
            const failed = finalState.errors.length;
            resultPayload = createResultPayload(
              "line-progress",
              files.length,
              skippedExisting,
              processed,
              failed,
              settings,
              visualsEnabled,
              selection,
            );
          }).pipe(Effect.ensuring(Effect.sync(() => progress.cleanup())));
        } else {
          // Simple console mode
          let processed = 0;
          let errors = 0;

          for (const filePath of files) {
            const filename = basename(filePath);
            processed++;

            const fileResult = yield* Effect.either(
              Effect.gen(function* () {
                const mode = enrich
                  ? "enrich"
                  : autoTag
                    ? "auto-tag"
                    : "manual";
                yield* Console.log(
                  `[${processed}/${files.length}] Adding: ${filename}${
                    mode !== "manual" ? ` (${mode})` : ""
                  }`,
                );

                const prepared = yield* prepareIngestSource(
                  filePath,
                  settings,
                  (content) => {
                    if (!enrich) return Effect.void;
                    return Console.log(
                      content
                        ? "    Enriching with LLM..."
                        : "    No content extracted, using heuristics",
                    );
                  },
                );
                const { metadata } = prepared;
                yield* logEnrichmentDetails(Console, metadata);

                const addOptions = createAddOptions(
                  prepared,
                  visualsEnabled,
                  visualsMode,
                );
                const doc = yield* library.add(
                  filePath,
                  addOptions,
                );
                yield* acceptProposalsAfterCommit(Console, metadata);
                yield* Console.log(
                  `  OK ${doc.title} (${doc.pageCount} pages)`,
                );
                if (metadata.tags.length > 0) {
                  yield* Console.log(`    Tags: ${doc.tags.join(", ")}`);
                }

                // Checkpoint every N documents to prevent WAL accumulation
                if (shouldCheckpoint(processed, CHECKPOINT_INTERVAL)) {
                  yield* Console.log(
                    `  Checkpoint Checkpointing WAL (${processed} docs)...`,
                  );
                  const checkpointResult = yield* Effect.either(
                    library.checkpoint(),
                  );
                  if (checkpointResult._tag === "Left") {
                    yield* Console.log(
                      `  WARN Checkpoint warning: ${checkpointResult.left}`,
                    );
                  }
                }
              }),
            );
            if (fileResult._tag === "Left") {
              errors++;
              yield* Console.error(`  FAIL Failed: ${String(fileResult.left)}`);
            }
          }

          yield* Console.log(`\nOK Ingested ${processed - errors} files`);
          if (errors > 0) {
            yield* Console.log(`WARN ${errors} files failed`);
          }

          resultPayload = createResultPayload(
            "simple",
            files.length,
            skippedExisting,
            processed,
            errors,
            settings,
            visualsEnabled,
            selection,
          );
        }
        return { resultPayload, agentResult };
      }),
    options,
  );
}
