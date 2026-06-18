import { Effect } from "effect";
import { assessDocChunker } from "../../chunking.js";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import type {
  DocumentWithSourceIdentity,
} from "../../services/StorageRepositories.js";
import {
  fingerprintSource,
  type SourceFingerprint,
} from "../../services/SourceIntegrity.js";
import {
  AddOptions,
  LibraryConfig,
  resolveVisualsConfig,
} from "../../types.js";
import {
  CLIError,
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

interface RechunkCommandOptions extends Record<string, unknown> {
  doc?: string;
  tag?: string;
  "dry-run"?: boolean;
  dryRun?: boolean;
  all?: boolean;
  "include-missing"?: boolean;
  includeMissing?: boolean;
  missing?: boolean;
  visuals?: boolean;
  "max-docs"?: string | number | boolean;
  maxDocs?: string | number | boolean;
  "max-chunks"?: string | number | boolean;
  maxChunks?: string | number | boolean;
}

type VisualsConfig = ReturnType<typeof resolveVisualsConfig>;
type VisualsMode = "config" | "explicit" | undefined;

interface RechunkPlanItem {
  id: string;
  title: string;
  path: string;
  reason: string;
  code: string;
  expected: unknown;
  actual: unknown;
  currentChunkCount?: number;
}

interface RechunkPlan {
  items: RechunkPlanItem[];
  plannedMissing: number;
  plannedMismatch: number;
  plannedVisuals: number;
  skippedMissing: number;
}

interface RechunkWarning {
  code: string;
  message: string;
  details?: unknown;
}

const CHUNKER_SUMMARY = {
  pdf: { id: "pdf-extractor:shared-context-v6", version: 6 },
  markdown: { id: "markdown-extractor:shared-context-v3", version: 3 },
  docx: { id: "office-extractor:docx-shared-context-v4", version: 4 },
  odt: { id: "office-extractor:odt-shared-context-v3", version: 3 },
  unit: "chars",
} as const;

function parsePositiveIntFlag(
  raw: string | number | boolean | undefined,
  flag: string,
): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === true) {
    throw new CLIError("INVALID_ARGS", `${flag} requires a numeric value`, {
      flag,
      hint: `${flag} 25`,
    });
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CLIError("INVALID_ARGS", `${flag} must be a positive integer`, {
      flag,
      value: raw,
      hint: `${flag} 25`,
    });
  }

  return Math.floor(value);
}

function parseLimits(options: RechunkCommandOptions) {
  return Effect.try({
    try: () => ({
      maxDocs: parsePositiveIntFlag(
        options["max-docs"] ?? options.maxDocs,
        "--max-docs",
      ),
      maxChunks: parsePositiveIntFlag(
        options["max-chunks"] ?? options.maxChunks,
        "--max-chunks",
      ),
    }),
    catch: (error) =>
      error instanceof CLIError
        ? error
        : new CLIError("INVALID_ARGS", String(error), {
            command: "rechunk",
          }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getVisualsMetadata(
  doc: DocumentWithSourceIdentity["document"],
): unknown {
  return doc.metadata?.visuals;
}

function needsVisualRefresh(
  doc: DocumentWithSourceIdentity["document"],
  visualsEnabled: boolean,
  visualsConfig: VisualsConfig,
): boolean {
  if (!visualsEnabled) return false;
  if (doc.fileType !== "pdf" && doc.fileType !== "docx") return false;

  const visuals = getVisualsMetadata(doc);
  return (
    !isRecord(visuals) ||
    visuals.enabled !== true ||
    visuals.version !== 1 ||
    visuals.maxImageBytes !== visualsConfig.maxImageBytes ||
    visuals.maxImagesPerDocument !== visualsConfig.maxImagesPerDocument
  );
}

function buildPlan(
  records: readonly DocumentWithSourceIdentity[],
  config: LibraryConfig,
  options: {
    forceAll: boolean;
    includeMissing: boolean;
    visualsEnabled: boolean;
    visualsConfig: VisualsConfig;
    explicitDocument: boolean;
    explicitFingerprint?: SourceFingerprint;
  },
): RechunkPlan {
  const items: RechunkPlanItem[] = [];
  let plannedMissing = 0;
  let plannedMismatch = 0;
  let plannedVisuals = 0;
  let skippedMissing = 0;

  for (const record of records) {
    const doc = record.document;
    const assessment = assessDocChunker(doc, config);
    const isMissing = assessment.code === "missing_metadata";
    const identityMissing = record.sourceIdentity.status === "missing";
    const identityInvalid = record.sourceIdentity.status === "invalid";
    const sourceChanged =
      record.sourceIdentity.status === "valid" &&
      options.explicitFingerprint !== undefined &&
      record.sourceIdentity.identity.hash !==
        options.explicitFingerprint.identity.hash;
    const visualRefresh = needsVisualRefresh(
      doc,
      options.visualsEnabled,
      options.visualsConfig,
    );
    const shouldInclude =
      options.forceAll ||
      visualRefresh ||
      identityInvalid ||
      sourceChanged ||
      (identityMissing &&
        (options.explicitDocument || options.includeMissing)) ||
      (assessment.needsRechunk &&
        (!isMissing || options.includeMissing || options.explicitDocument));

    if (
      ((assessment.needsRechunk && isMissing) || identityMissing) &&
      !options.includeMissing &&
      !options.forceAll &&
      !options.explicitDocument
    ) {
      skippedMissing++;
    }

    if (!shouldInclude) continue;

    let reason = assessment.reason;
    let code: string = assessment.code;
    if (sourceChanged) {
      reason = "source content changed";
      code = "source_changed";
    } else if (identityInvalid) {
      reason = "source identity is invalid";
      code = "invalid_identity";
    } else if (identityMissing) {
      reason = "source identity is missing";
      code = "missing_identity";
    } else if (visualRefresh && !assessment.needsRechunk) {
      reason = "visual enrichment metadata mismatch";
      code = "visuals_mismatch";
    }

    items.push({
      id: doc.id,
      title: doc.title,
      path: doc.path,
      reason,
      code,
      expected: assessment.expected,
      actual: visualRefresh
        ? {
            chunker: assessment.actual,
            visuals: getVisualsMetadata(doc) ?? null,
          }
        : assessment.actual,
    });

    if (identityMissing || (assessment.needsRechunk && isMissing)) {
      plannedMissing++;
    } else if (
      identityInvalid ||
      sourceChanged ||
      assessment.needsRechunk
    ) {
      plannedMismatch++;
    }
    if (visualRefresh) plannedVisuals++;
  }

  return {
    items,
    plannedMissing,
    plannedMismatch,
    plannedVisuals,
    skippedMissing,
  };
}

function buildWarnings(
  plannedCount: number,
  includeMissing: boolean,
  skippedMissing: number,
  totalCurrentChunks: number,
): RechunkWarning[] {
  const warnings: RechunkWarning[] = [];

  if (plannedCount > 0) {
    warnings.push({
      code: "RECHUNK_REEMBEDS",
      message:
        "Rechunk regenerates embeddings because embeddings are per-chunk; changing chunk boundaries/content requires new vectors.",
    });
  }
  if (includeMissing) {
    warnings.push({
      code: "RECHUNK_INCLUDE_MISSING",
      message:
        "--include-missing is intended for upgrade sweeps. This is typically expensive because it will re-embed many chunks.",
    });
  }
  if (skippedMissing > 0) {
    warnings.push({
      code: "RECHUNK_SKIPPED_MISSING",
      message:
        "Some documents are missing chunker metadata and were skipped. Pass --include-missing to include them.",
      details: { skippedMissing },
    });
  }
  if (totalCurrentChunks > 0) {
    warnings.push({
      code: "RECHUNK_COST_ESTIMATE",
      message:
        "Estimated cost is based on current chunk counts. New chunk counts may differ after rechunking.",
      details: { totalCurrentChunks },
    });
  }

  return warnings;
}

function getVisualSettings(
  visualsEnabled: boolean,
  visualsConfig: VisualsConfig,
) {
  if (!visualsEnabled) return null;

  return {
    maxImageBytes: visualsConfig.maxImageBytes,
    maxImagesPerDocument: visualsConfig.maxImagesPerDocument,
  };
}

export function runRechunkCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: RechunkCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ library, globals }) =>
    Effect.gen(function* () {
      const command = args[0];
      if (command !== "rechunk") {
        return yield* Effect.fail(
          new CLIError(
            "UNKNOWN_COMMAND",
            `Unknown rechunk command: ${command}`,
            { command },
          ),
        );
      }

      const singleDocId = options.doc;
      const tag = options.tag;
      const dryRun =
        options["dry-run"] === true || options.dryRun === true;
      const forceAll = options.all === true;
      const includeMissing =
        options["include-missing"] === true ||
        options.includeMissing === true ||
        options.missing === true;
      const appConfig = globals.config!;
      const visualsConfig = resolveVisualsConfig(appConfig);
      const visualsExplicit = options.visuals === true;
      const visualsEnabled = visualsExplicit || visualsConfig.enabled;
      const visualsMode: VisualsMode = visualsEnabled
        ? visualsExplicit
          ? "explicit"
          : "config"
        : undefined;
      const { maxDocs, maxChunks } = yield* parseLimits(options);
      const config = LibraryConfig.fromConfig(appConfig);
      const records = singleDocId
        ? yield* library.getWithSourceIdentity(singleDocId).pipe(
            Effect.map((record) => (record ? [record] : [])),
          )
        : yield* library.listWithSourceIdentity(tag);

      if (records.length === 0) {
        return {
          resultPayload: {
            dryRun,
            totalCandidates: 0,
            planned: 0,
            succeeded: 0,
            failed: 0,
          },
          agentResult: null,
        };
      }

      const explicitFingerprint = singleDocId
        ? yield* fingerprintSource(records[0].document.path)
        : undefined;
      const plan = buildPlan(records, config, {
        forceAll,
        includeMissing,
        visualsEnabled,
        visualsConfig,
        explicitDocument: singleDocId !== undefined,
        explicitFingerprint,
      });
      let planned = plan.items;

      let totalCurrentChunks = 0;
      const countsResult = yield* Effect.either(
        library.countChunksByDocumentIds(planned.map((item) => item.id)),
      );
      if (countsResult._tag === "Right") {
        for (const item of planned) {
          const count = countsResult.right[item.id] ?? 0;
          item.currentChunkCount = count;
          totalCurrentChunks += count;
        }
      }

      const warnings = buildWarnings(
        planned.length,
        includeMissing,
        plan.skippedMissing,
        totalCurrentChunks,
      );
      const effectiveMaxDocs =
        maxDocs ?? (!dryRun && includeMissing ? 25 : undefined);

      if (
        !dryRun &&
        effectiveMaxDocs !== undefined &&
        planned.length > effectiveMaxDocs
      ) {
        if (maxDocs === undefined) {
          return yield* Effect.fail(
            new CLIError(
              "TOO_MANY_DOCS",
              `Refusing to rechunk ${planned.length} documents (limit: ${effectiveMaxDocs}).`,
              {
                planned: planned.length,
                maxDocs: effectiveMaxDocs,
                hint: includeMissing
                  ? `Re-run with --max-docs ${planned.length} if you really want the full upgrade, or start with: poink rechunk --include-missing --max-docs 25`
                  : `Re-run with --max-docs ${planned.length} if you really want to process all planned docs.`,
              },
            ),
          );
        }

        yield* Effect.logInfo(
          `Truncating ${planned.length} candidates to --max-docs ${effectiveMaxDocs}`,
        );
        planned = planned.slice(0, effectiveMaxDocs);
      }

      if (
        !dryRun &&
        maxChunks !== undefined &&
        totalCurrentChunks > maxChunks
      ) {
        return yield* Effect.fail(
          new CLIError(
            "TOO_MANY_CHUNKS",
            `Refusing to rechunk ~${totalCurrentChunks} chunks (limit: ${maxChunks}).`,
            {
              totalCurrentChunks,
              maxChunks,
              hint:
                "Lower scope (use --doc/--tag) or raise the limit (e.g. --max-chunks 200000).",
            },
          ),
        );
      }

      const commonResult = {
        forceAll,
        includeMissing,
        visuals: visualsEnabled,
        visualSettings: getVisualSettings(visualsEnabled, visualsConfig),
        tag: tag ?? null,
        docId: singleDocId ?? null,
        totalCandidates: records.length,
        planned: planned.length,
        plannedMissing: plan.plannedMissing,
        plannedMismatch: plan.plannedMismatch,
        plannedVisuals: plan.plannedVisuals,
        skippedMissing: plan.skippedMissing,
        totalCurrentChunks,
        warnings,
      };
      const commonAgentResult = {
        _tag: "rechunk" as const,
        includeMissing,
        visuals: visualsEnabled,
        skippedMissing: plan.skippedMissing,
        plannedMissing: plan.plannedMissing,
        plannedMismatch: plan.plannedMismatch,
        plannedVisuals: plan.plannedVisuals,
        planned: planned.length,
      };

      if (dryRun) {
        return {
          resultPayload: {
            dryRun: true,
            ...commonResult,
            maxDocs: maxDocs ?? null,
            maxChunks: maxChunks ?? null,
            docs: planned,
            chunker: {
              ...CHUNKER_SUMMARY,
              chunkSize: config.chunkSize,
              chunkOverlap: config.chunkOverlap,
            },
          },
          agentResult: {
            ...commonAgentResult,
            dryRun: true,
            succeeded: 0,
            failed: 0,
          },
        };
      }

      const embedProvider = yield* EmbeddingProvider;
      const healthResult = yield* Effect.either(embedProvider.checkHealth());
      if (healthResult._tag === "Left") {
        return yield* Effect.fail(
          new CLIError(
            "PROVIDER_NOT_READY",
            "Embedding provider not ready",
            {
              reason: String(healthResult.left),
              provider: embedProvider.provider,
            },
          ),
        );
      }

      let processed = 0;
      let errors = 0;
      for (const item of planned) {
        processed++;
        const itemResult = yield* Effect.either(
          Effect.gen(function* () {
            const doc = yield* library.get(item.id);
            if (!doc) return false;

            const replaceOptions = new AddOptions({
              title: doc.title,
              tags: doc.tags.length > 0 ? doc.tags : undefined,
              metadata: doc.metadata,
              visuals: visualsEnabled ? true : undefined,
              visualsMode,
              addedAt: doc.addedAt,
              sourceContext:
                singleDocId === item.id && explicitFingerprint
                  ? { initialFingerprint: explicitFingerprint }
                  : undefined,
            });
            const replaceResult = yield* Effect.either(
              library.replace(doc.path, replaceOptions),
            );
            if (replaceResult._tag === "Right") return true;

            yield* Effect.logInfo(
              `WARN Rechunk failed for "${doc.title}": ${String(replaceResult.left)}`,
            );
            return false;
          }),
        );
        if (itemResult._tag === "Left" || !itemResult.right) {
          errors++;
        }
      }

      return {
        resultPayload: {
          dryRun: false,
          ...commonResult,
          maxDocs: effectiveMaxDocs ?? null,
          maxChunks: maxChunks ?? null,
          succeeded: processed - errors,
          failed: errors,
        },
        agentResult: {
          ...commonAgentResult,
          dryRun: false,
          succeeded: processed - errors,
          failed: errors,
        },
      };
    }),
    options,
  );
}
