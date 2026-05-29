import { Effect } from "effect";
import { basename, extname, join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { AddOptions } from "../../index.js";
import { loadConfig, resolveVisualsConfig } from "../../types.js";
import { resolveUserPath } from "../../pathUtils.js";
import { fileTypeFromExtension } from "../../urlDownloads.js";
import { AutoTagger } from "../../services/AutoTagger.js";
import { PDFExtractor } from "../../services/PDFExtractor.js";
import { OfficeExtractor } from "../../services/OfficeExtractor.js";
import { createInitialState, renderIngestProgress, type FileStatus } from "../ingestProgress.js";
import { CLIError, extractEnrichmentPreview, runCommandWithContext, shouldCheckpoint, type GlobalCLIOptions } from "../runner.js";

interface IngestCommandOptions extends Record<string, unknown> {
  enrich?: boolean;
  visuals?: boolean;
  "auto-tag"?: boolean;
  tags?: string;
  sample?: string | number;
  recursive?: boolean;
  "no-recursive"?: boolean;
  progress?: boolean;
}

export function runIngestCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: IngestCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, format, library }) =>
    Effect.gen(function* () {
      let resultPayload: unknown = null;
      let agentResult: any = null;
      const command = args[0];
      switch (command) {
    case "ingest": {
      // Support multiple directories: poink ingest dir1 dir2 dir3 --enrich
      const directories: string[] = [];
      let i = 1;
      while (i < args.length && !args[i].startsWith("--")) {
        directories.push(args[i]);
        i++;
      }

	      if (directories.length === 0) {
	        yield* Console.error("Error: At least one directory required");
        yield* Console.error(
          "Usage: poink ingest <dir1> [dir2] [dir3] [options]"
        );
        yield* Console.error("");
        yield* Console.error("Options:");
        yield* Console.error(
          "  --enrich       Full LLM enrichment (title, summary, concepts)"
        );
        yield* Console.error(
          "  --visuals      Describe embedded PDF/DOCX images as searchable chunks"
        );
        yield* Console.error(
          "  --auto-tag     Light tagging (heuristics + LLM)"
        );
        yield* Console.error("  --tags a,b,c   Manual tags for all files");
        yield* Console.error("  --sample N     Process only first N files");
	        yield* Console.error("  --no-progress  Disable line progress output");
	        return yield* Effect.fail(
	          new CLIError("INVALID_ARGS", "At least one directory required", {
	            command: "ingest",
	            hint: "poink ingest ./docs --enrich",
	          })
	        );
	      }

      // Resolve and validate directories
      const targetDirs: string[] = [];
	      for (const dir of directories) {
	        const targetDir = resolveUserPath(dir);
	        if (!existsSync(targetDir)) {
	          yield* Console.error(`Error: Directory not found: ${targetDir}`);
	          return yield* Effect.fail(
	            new CLIError("NOT_FOUND", `Directory not found: ${targetDir}`, {
	              targetDir,
	            })
	          );
	        }
	        const dirStat = statSync(targetDir);
	        if (!dirStat.isDirectory()) {
	          yield* Console.error(`Error: Not a directory: ${targetDir}`);
	          return yield* Effect.fail(
	            new CLIError("INVALID_ARGS", `Not a directory: ${targetDir}`, {
	              targetDir,
	            })
	          );
	        }
	        targetDirs.push(targetDir);
	      }

      const opts = options;
      const recursive = opts["no-recursive"] === true ? false : opts.recursive !== false; // default true
      const manualTags = opts.tags
        ? (opts.tags as string).split(",").map((t) => t.trim())
        : undefined;
      const sampleSize = opts.sample
        ? parseInt(String(opts.sample), 10)
        : undefined;
      // Agent-only mode: progress writes to stdout and will break JSON parsing.
      // Only allow progress in explicit `--format text` mode.
      const useProgress = format === "text" && opts.progress !== false;
      const autoTag = opts["auto-tag"] === true;
      const enrich = opts.enrich === true;
      const ingestConfig = loadConfig();
      const visualsExplicit = opts.visuals === true;
      const visualsEnabled =
        visualsExplicit || resolveVisualsConfig(ingestConfig).enabled;
      const visualsMode = visualsEnabled
        ? visualsExplicit
          ? "explicit"
          : "config"
        : undefined;
      // Always checkpoint after every file for crash safety
      const checkpointInterval = 1;

      // Discover files from all directories
      yield* Console.log(
        `Scanning ${targetDirs.length} director${
          targetDirs.length > 1 ? "ies" : "y"
        }...`
      );

      const discoverFiles = (dir: string): string[] => {
        const files: string[] = [];
        try {
          const entries = readdirSync(dir);
          for (const entry of entries) {
            const fullPath = join(dir, entry);
            try {
              const stat = statSync(fullPath);
              if (stat.isDirectory() && recursive) {
                files.push(...discoverFiles(fullPath));
              } else if (stat.isFile()) {
                const ext = extname(entry).toLowerCase();
                if (fileTypeFromExtension(ext)) {
                  files.push(fullPath);
                }
              }
            } catch {
              // Skip files we can't access
            }
          }
        } catch {
          // Skip directories we can't read
        }
        return files;
      };

      let files: string[] = [];
      for (const dir of targetDirs) {
        const found = discoverFiles(dir);
        yield* Console.log(`  ${basename(dir)}: ${found.length} files`);
        files.push(...found);
      }
      yield* Console.log(`Total: ${files.length} files`);

      if (files.length === 0) {
        yield* Console.log("No supported document files found");
        resultPayload = {
          foundFiles: 0,
          skippedExisting: 0,
          processed: 0,
          succeeded: 0,
          failed: 0,
        };
        break;
      }

      // Apply sample limit if specified
      if (sampleSize && sampleSize < files.length) {
        files = files.slice(0, sampleSize);
        yield* Console.log(`Processing sample of ${sampleSize} files`);
      }

      // Check what's already in the library to skip duplicates
      const existingDocs = yield* library.list();
      const existingPaths = new Set(existingDocs.map((d) => d.path));
      const newFiles = files.filter((f) => !existingPaths.has(f));
      const skippedExisting = files.length - newFiles.length;

      if (newFiles.length < files.length) {
        yield* Console.log(
          `Skipping ${skippedExisting} already-ingested files`
        );
      }

      if (newFiles.length === 0) {
        yield* Console.log("All files already ingested");
        resultPayload = {
          foundFiles: files.length,
          skippedExisting,
          processed: 0,
          succeeded: 0,
          failed: 0,
        };
        break;
      }

      files = newFiles;

      // Check if we can use line progress (requires TTY)
      const canUseProgress =
        useProgress && process.stdout.isTTY && process.stdin.isTTY;
      if (useProgress && !canUseProgress) {
        yield* Console.log("Progress disabled (not a TTY), using simple output");
      }

      // Process files
      if (canUseProgress) {
        // Line progress mode
        const state = createInitialState();
        state.totalFiles = files.length;
        state.phase = "processing";

        const progress = renderIngestProgress(state);

        try {
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

            try {
              // Get tags - either manual, auto-generated, or none
              let fileTags = manualTags ? [...manualTags] : [];
              let title: string | undefined;

              if (autoTag || enrich) {
                const tagger = yield* AutoTagger;
                const pdfExtractor = yield* PDFExtractor;
                const officeExtractor = yield* OfficeExtractor;
                const content = yield* extractEnrichmentPreview(filePath, {
                  enrich,
                  pdfExtractor,
                  officeExtractor,
                });

                currentFile.status = "embedding";
                progress.update({ currentFile });

                if (enrich && content) {
                  const enrichResult = yield* tagger.enrich(filePath, content, {
                    basePath: targetDirs[0],
                  });
                  title = enrichResult.title;
                  fileTags = [...fileTags, ...enrichResult.tags];
                } else if (enrich && !content) {
                  // Enrichment requested but no content
                  const tagResult = yield* tagger.generateTags(
                    filePath,
                    undefined,
                    {
                      heuristicsOnly: true,
                      basePath: targetDirs[0],
                    }
                  );
                  fileTags = [...fileTags, ...tagResult.allTags];
                } else {
                  const tagResult = yield* tagger.generateTags(
                    filePath,
                    content,
                    {
                      heuristicsOnly: !content,
                      basePath: targetDirs[0],
                    }
                  );
                  fileTags = [...fileTags, ...tagResult.allTags];
                }
              }

              // Add the file
              const doc = yield* library.add(
                filePath,
                new AddOptions({
                  title,
                  tags: fileTags.length > 0 ? fileTags : undefined,
                  visuals: visualsEnabled ? true : undefined,
                  visualsMode,
                })
              );

              currentFile.status = "done";
              currentFile.chunks = doc.pageCount;

              progress.update({
                processedFiles: i + 1,
                currentFile,
                recentFiles: [...progress.getState().recentFiles, currentFile],
              });

              // Checkpoint every N documents to prevent WAL accumulation
              if (shouldCheckpoint(i + 1, checkpointInterval)) {
                progress.update({
                  checkpointInProgress: true,
                  checkpointMessage: `Checkpointing WAL (${i + 1} docs)...`,
                });

                const checkpointResult = yield* Effect.either(
                  library.checkpoint()
                );

                if (checkpointResult._tag === "Left") {
                  yield* Effect.logError(
                    `Warning: Checkpoint failed at ${i + 1} docs: ${
                      checkpointResult.left
                    }`
                  );
                }

                progress.update({
                  checkpointInProgress: false,
                  checkpointMessage: undefined,
                  lastCheckpointAt: i + 1,
                });
              }
            } catch (error) {
              currentFile.status = "error";
              currentFile.error =
                error instanceof Error ? error.message : String(error);

              progress.update({
                processedFiles: i + 1,
                currentFile,
                recentFiles: [...progress.getState().recentFiles, currentFile],
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
            } files`
          );
          if (finalState.errors.length > 0) {
            yield* Console.log(`WARN ${finalState.errors.length} files failed`);
          }

          const processed = finalState.processedFiles;
          const failed = finalState.errors.length;
          resultPayload = {
            mode: "line-progress",
            totalPlanned: files.length,
            skippedExisting,
            processed,
            succeeded: processed - failed,
            failed,
            enrich,
            visuals: visualsEnabled,
            autoTag,
            manualTags: manualTags ?? null,
          };
        } catch (error) {
          progress.cleanup();
          throw error;
        }
      } else {
        // Simple console mode
        let processed = 0;
        let errors = 0;

        for (const filePath of files) {
          const filename = basename(filePath);
          processed++;

          try {
            const mode = enrich ? "enrich" : autoTag ? "auto-tag" : "manual";
            yield* Console.log(
              `[${processed}/${files.length}] Adding: ${filename}${
                mode !== "manual" ? ` (${mode})` : ""
              }`
            );

            // Start with manual tags
            let fileTags = manualTags ? [...manualTags] : [];
            let title: string | undefined;

            // For auto-tag or enrich, we need to read content first
            if (autoTag || enrich) {
              const tagger = yield* AutoTagger;
              const pdfExtractor = yield* PDFExtractor;
              const officeExtractor = yield* OfficeExtractor;
              const content = yield* extractEnrichmentPreview(filePath, {
                enrich,
                pdfExtractor,
                officeExtractor,
              });

              if (enrich && content) {
                // Full enrichment with LLM
                yield* Console.log(`    Enriching with LLM...`);
                const enrichResult = yield* tagger.enrich(filePath, content, {
                  basePath: targetDirs[0],
                });
                title = enrichResult.title;
                fileTags = [...fileTags, ...enrichResult.tags];
                yield* Console.log(`    Title: ${enrichResult.title}`);
                if (enrichResult.author) {
                  yield* Console.log(`    Author: ${enrichResult.author}`);
                }
                yield* Console.log(`    Type: ${enrichResult.documentType}`);
                yield* Console.log(
                  `    Tags: ${enrichResult.tags.slice(0, 5).join(", ")}`
                );
                if (enrichResult.concepts && enrichResult.concepts.length > 0) {
                  yield* Console.log(
                    `    Concepts: ${enrichResult.concepts
                      .slice(0, 3)
                      .join(", ")}`
                  );
                }
                // Proposed concepts are now auto-accepted in AutoTagger
                if (
                  enrichResult.proposedConcepts &&
                  enrichResult.proposedConcepts.length > 0
                ) {
                  yield* Console.log(
                    `    Auto-accepted: ${enrichResult.proposedConcepts
                      .map((c) => c.prefLabel)
                      .join(", ")}`
                  );
                }
              } else if (enrich && !content) {
                // Enrichment requested but no content - fall back to heuristics
                yield* Console.log(
                  `    No content extracted, using heuristics`
                );
                const tagResult = yield* tagger.generateTags(
                  filePath,
                  undefined,
                  {
                    heuristicsOnly: true,
                    basePath: targetDirs[0],
                  }
                );
                fileTags = [...fileTags, ...tagResult.allTags];
              } else {
                // Just auto-tag (heuristics + optional LLM)
                const tagResult = yield* tagger.generateTags(
                  filePath,
                  content,
                  {
                    heuristicsOnly: !content,
                    basePath: targetDirs[0],
                  }
                );
                fileTags = [...fileTags, ...tagResult.allTags];
              }
            }

            const doc = yield* library.add(
              filePath,
              new AddOptions({
                title,
                tags: fileTags.length > 0 ? fileTags : undefined,
                visuals: visualsEnabled ? true : undefined,
                visualsMode,
              })
            );
            yield* Console.log(`  OK ${doc.title} (${doc.pageCount} pages)`);
            if (fileTags.length > 0) {
              yield* Console.log(`    Tags: ${doc.tags.join(", ")}`);
            }

            // Checkpoint every N documents to prevent WAL accumulation
            if (shouldCheckpoint(processed, checkpointInterval)) {
              yield* Console.log(
                `  Checkpoint Checkpointing WAL (${processed} docs)...`
              );
              const checkpointResult = yield* Effect.either(
                library.checkpoint()
              );
              if (checkpointResult._tag === "Left") {
                yield* Console.log(
                  `  WARN Checkpoint warning: ${checkpointResult.left}`
                );
              }
            }
          } catch (error) {
            errors++;
            const msg = error instanceof Error ? error.message : String(error);
            yield* Console.error(`  FAIL Failed: ${msg}`);
          }
        }

        yield* Console.log(`\nOK Ingested ${processed - errors} files`);
        if (errors > 0) {
          yield* Console.log(`WARN ${errors} files failed`);
        }

        resultPayload = {
          mode: "simple",
          totalPlanned: files.length,
          skippedExisting,
          processed,
          succeeded: processed - errors,
          failed: errors,
          enrich,
          visuals: visualsEnabled,
          autoTag,
          manualTags: manualTags ?? null,
        };
      }
      break;
    }

        default:
          return yield* Effect.fail(new CLIError("UNKNOWN_COMMAND", `Unknown ingest command: ${command}`, { command }));
      }
      return { resultPayload, agentResult };
    }),
    options);
}
