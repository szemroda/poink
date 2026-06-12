import { Effect } from "effect";
import { existsSync } from "fs";
import { AddOptions, LibraryConfig } from "../../types.js";
import { assessDocChunker } from "../../chunking.js";
import { resolveVisualsConfig, type Document } from "../../types.js";
import { EmbeddingProvider } from "../../services/EmbeddingProvider.js";
import { CLIError, runCommandWithContext, type GlobalCLIOptions } from "../runner.js";

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

export function runRechunkCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: RechunkCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library, globals }) =>
    Effect.gen(function* () {
      let resultPayload: unknown = null;
      let agentResult: any = null;
      const command = args[0];
      switch (command) {
      case "rechunk": {
        const opts = options;
        const singleDocId = opts.doc as string | undefined;
        const tag = opts.tag as string | undefined;
        const dryRun = opts["dry-run"] === true || opts.dryRun === true;
        const forceAll = opts.all === true;
        const includeMissing =
          opts["include-missing"] === true ||
          opts.includeMissing === true ||
          opts.missing === true;
        const rechunkAppConfig = globals.config!;
        const rechunkVisualsConfig = resolveVisualsConfig(rechunkAppConfig);
        const visualsExplicit = opts.visuals === true;
        const visualsEnabled = visualsExplicit || rechunkVisualsConfig.enabled;
        const visualsMode = visualsEnabled
          ? visualsExplicit
            ? "explicit"
            : "config"
          : undefined;

        const parsePositiveIntFlag = (
          raw: string | number | boolean | undefined,
          flag: string,
        ): number | undefined => {
          if (raw === undefined) return undefined;
          if (raw === true) {
            throw new CLIError(
              "INVALID_ARGS",
              `${flag} requires a numeric value`,
              { flag, hint: `${flag} 25` },
            );
          }
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) {
            throw new CLIError(
              "INVALID_ARGS",
              `${flag} must be a positive integer`,
              { flag, value: raw, hint: `${flag} 25` },
            );
          }
          return Math.floor(n);
        };

        const [parsedMaxDocs, parsedMaxChunks] = yield* Effect.try({
          try: () => [
            parsePositiveIntFlag(opts["max-docs"] ?? opts.maxDocs, "--max-docs"),
            parsePositiveIntFlag(opts["max-chunks"] ?? opts.maxChunks, "--max-chunks"),
          ] as const,
          catch: (error) =>
            error instanceof CLIError
              ? error
              : new CLIError("INVALID_ARGS", String(error), {
                  command: "rechunk",
                }),
        });

	        const config = LibraryConfig.fromConfig(rechunkAppConfig);
	
	        const docs = singleDocId
	          ? yield* library.get(singleDocId).pipe(
	              Effect.map((doc) => (doc ? [doc] : [])),
	            )
          : yield* library.list(tag);

        if (docs.length === 0) {
          resultPayload = {
            dryRun,
            totalCandidates: 0,
            planned: 0,
            succeeded: 0,
            failed: 0,
          };
          break;
        }

        let planned: Array<{
          id: string;
          title: string;
          path: string;
          reason: string;
          code: string;
          expected: unknown;
          actual: unknown;
          currentChunkCount?: number;
        }> = [];

        let plannedMissing = 0;
        let plannedMismatch = 0;
        let plannedVisuals = 0;
        let skippedMissing = 0;

        const needsVisualRefresh = (doc: Document): boolean => {
          if (!visualsEnabled) return false;
          const fileType = doc.fileType;
          if (fileType !== "pdf" && fileType !== "docx") return false;
          const visuals = (doc.metadata as any)?.visuals;
          return (
            !visuals ||
            visuals.enabled !== true ||
            visuals.version !== 1 ||
            visuals.maxImageBytes !== rechunkVisualsConfig.maxImageBytes ||
            visuals.maxImagesPerDocument !==
              rechunkVisualsConfig.maxImagesPerDocument
          );
        };

        for (const doc of docs) {
          const assessment = assessDocChunker(doc, config);
          const isMissing = assessment.code === "missing_metadata";
          const visualRefresh = needsVisualRefresh(doc);
          const shouldInclude =
            forceAll ||
            visualRefresh ||
            (assessment.needsRechunk && (!isMissing || includeMissing));

          if (assessment.needsRechunk && isMissing && !includeMissing && !forceAll) {
            skippedMissing++;
          }

          if (shouldInclude) {
            planned.push({
              id: doc.id,
              title: doc.title,
              path: doc.path,
              reason:
                visualRefresh && !assessment.needsRechunk
                  ? "visual enrichment metadata mismatch"
                  : assessment.reason,
              code:
                visualRefresh && !assessment.needsRechunk
                  ? "visuals_mismatch"
                  : assessment.code,
              expected: assessment.expected,
              actual: visualRefresh
                ? {
                    chunker: assessment.actual,
                    visuals: (doc.metadata as any)?.visuals ?? null,
                  }
                : assessment.actual,
            });

            if (assessment.needsRechunk) {
              if (isMissing) plannedMissing++;
              else plannedMismatch++;
            }
            if (visualRefresh) plannedVisuals++;
          }
        }

        // Enrich plan with cost estimates (current chunk counts).
        let totalCurrentChunks = 0;
        const countsResult = yield* Effect.either(
          library.countChunksByDocumentIds(planned.map((p) => p.id)),
        );
        if (countsResult._tag === "Right") {
          const counts = countsResult.right;
          for (const p of planned) {
            const count = counts[p.id] ?? 0;
            p.currentChunkCount = count;
            totalCurrentChunks += count;
          }
        }

        const warnings: Array<{ code: string; message: string; details?: unknown }> = [];
        if (planned.length > 0) {
          warnings.push({
            code: "RECHUNK_REEMBEDS",
            message:
              "Rechunk regenerates embeddings because embeddings are per-chunk; changing chunk boundaries/content requires new vectors.",
          });
        }
        // Rechunk uses the ingestion service's atomic replacement operation.
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

        // Safety rails: rechunking a large library is expensive and potentially slow.
        // If we're including missing-metadata docs (common after upgrades), default to small batches unless
        // the caller explicitly opts into a larger run.
        const effectiveMaxDocs =
          parsedMaxDocs ?? (!dryRun && includeMissing ? 25 : undefined);

        // When --max-docs is explicitly provided, truncate the planned list instead of refusing.
        // The safety guard only triggers for the implicit default (25) when --include-missing is used
        // without an explicit --max-docs flag.
        if (!dryRun && effectiveMaxDocs !== undefined && planned.length > effectiveMaxDocs) {
          if (parsedMaxDocs !== undefined) {
            // Explicit --max-docs: truncate and proceed
            yield* Effect.logInfo(
              `Truncating ${planned.length} candidates to --max-docs ${effectiveMaxDocs}`,
            );
            planned = planned.slice(0, effectiveMaxDocs);
          } else {
            // Implicit default: refuse (safety guard)
            return yield* Effect.fail(
              new CLIError(
                "TOO_MANY_DOCS",
                `Refusing to rechunk ${planned.length} documents (limit: ${effectiveMaxDocs}).`,
                {
                  planned: planned.length,
                  maxDocs: effectiveMaxDocs,
                  hint:
                    includeMissing
                      ? `Re-run with --max-docs ${planned.length} if you really want the full upgrade, or start with: poink rechunk --include-missing --max-docs 25`
                      : `Re-run with --max-docs ${planned.length} if you really want to process all planned docs.`,
                },
              ),
            );
          }
        }

        if (
          !dryRun &&
          parsedMaxChunks !== undefined &&
          totalCurrentChunks > parsedMaxChunks
        ) {
          return yield* Effect.fail(
            new CLIError(
              "TOO_MANY_CHUNKS",
              `Refusing to rechunk ~${totalCurrentChunks} chunks (limit: ${parsedMaxChunks}).`,
              {
                totalCurrentChunks,
                maxChunks: parsedMaxChunks,
                hint:
                  "Lower scope (use --doc/--tag) or raise the limit (e.g. --max-chunks 200000).",
              },
            ),
          );
        }

	        if (dryRun) {
	          resultPayload = {
	            dryRun: true,
	            forceAll,
              includeMissing,
              visuals: visualsEnabled,
              visualSettings: visualsEnabled
                ? {
                    maxImageBytes: rechunkVisualsConfig.maxImageBytes,
                    maxImagesPerDocument:
                      rechunkVisualsConfig.maxImagesPerDocument,
                  }
                : null,
              maxDocs: parsedMaxDocs ?? null,
              maxChunks: parsedMaxChunks ?? null,
	            tag: tag ?? null,
	            docId: singleDocId ?? null,
	            totalCandidates: docs.length,
	            planned: planned.length,
              plannedMissing,
              plannedMismatch,
              plannedVisuals,
              skippedMissing,
              totalCurrentChunks,
              warnings,
	            docs: planned,
	            chunker: {
	              pdf: { id: "pdf-extractor:shared-context-v6", version: 6 },
	              markdown: { id: "markdown-extractor:shared-context-v3", version: 3 },
	              docx: { id: "office-extractor:docx-shared-context-v4", version: 4 },
	              odt: { id: "office-extractor:odt-shared-context-v3", version: 3 },
	              chunkSize: config.chunkSize,
	              chunkOverlap: config.chunkOverlap,
	              unit: "chars",
	            },
	          };
	          agentResult = {
	            _tag: "rechunk",
	            dryRun: true,
              includeMissing,
              visuals: visualsEnabled,
              skippedMissing,
              plannedMissing,
              plannedMismatch,
              plannedVisuals,
	            planned: planned.length,
	            succeeded: 0,
	            failed: 0,
	          };
	          break;
	        }

	        // Health check: rechunk will re-embed everything, so fail early if provider is down.
	        const embedProvider = yield* EmbeddingProvider;
	        const healthResult = yield* Effect.either(embedProvider.checkHealth());
	        if (healthResult._tag === "Left") {
	          return yield* Effect.fail(
	            new CLIError("PROVIDER_NOT_READY", "Embedding provider not ready", {
	              reason: String(healthResult.left),
	              provider: embedProvider.provider,
	            }),
	          );
	        }
	
	        let processed = 0;
	        let errors = 0;
	        for (const item of planned) {
          processed++;
          const itemResult = yield* Effect.either(Effect.gen(function* () {
            const doc = yield* library.get(item.id);
            if (!doc) {
              return false;
            }

            // Guard: don't delete the DB record if the source file is missing.
            if (!existsSync(doc.path)) {
              return false;
            }

            // Non-destructive: perform an atomic in-place rebuild (doc upsert + chunk/embedding replace).
            const replaceResult = yield* Effect.either(
              library.replace(
                doc.path,
                new AddOptions({
                  title: doc.title,
                  tags: doc.tags.length > 0 ? doc.tags : undefined,
                  metadata: doc.metadata,
                  visuals: visualsEnabled ? true : undefined,
                  visualsMode,
                  addedAt: doc.addedAt,
                }),
              ),
            );
            if (replaceResult._tag === "Left") {
              yield* Effect.logInfo(
                `WARN Rechunk failed for "${doc.title}": ${String(replaceResult.left)}`,
              );
              return false;
            }
            return true;
          }));
          if (itemResult._tag === "Left" || !itemResult.right) {
            errors++;
          }
        }

	        resultPayload = {
	          dryRun: false,
	          forceAll,
            includeMissing,
            maxDocs: effectiveMaxDocs ?? null,
            maxChunks: parsedMaxChunks ?? null,
            visuals: visualsEnabled,
            visualSettings: visualsEnabled
              ? {
                  maxImageBytes: rechunkVisualsConfig.maxImageBytes,
                  maxImagesPerDocument:
                    rechunkVisualsConfig.maxImagesPerDocument,
                }
              : null,
	          tag: tag ?? null,
	          docId: singleDocId ?? null,
	          totalCandidates: docs.length,
	          planned: planned.length,
            plannedMissing,
            plannedMismatch,
            plannedVisuals,
            skippedMissing,
            totalCurrentChunks,
            warnings,
	          succeeded: processed - errors,
	          failed: errors,
	        };
	        agentResult = {
	          _tag: "rechunk",
	          dryRun: false,
            includeMissing,
            visuals: visualsEnabled,
            skippedMissing,
            plannedMissing,
            plannedMismatch,
            plannedVisuals,
	          planned: planned.length,
	          succeeded: processed - errors,
	          failed: errors,
	        };
	        break;
	      }

        default:
          return yield* Effect.fail(new CLIError("UNKNOWN_COMMAND", `Unknown rechunk command: ${command}`, { command }));
      }
      return { resultPayload, agentResult };
    }),
    options);
}
