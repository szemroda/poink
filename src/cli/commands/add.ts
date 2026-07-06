import { Effect } from "effect";
import { existsSync, mkdirSync } from "fs";
import { basename, join } from "path";
import {
  AddOptions,
  LibraryConfig,
  resolveVisualsConfig,
} from "../../types.js";
import {
  AutoTagger,
  type EnrichmentResult,
} from "../../services/AutoTagger.js";
import { PDFExtractor } from "../../services/PDFExtractor.js";
import { OfficeExtractor } from "../../services/OfficeExtractor.js";
import { fingerprintSource } from "../../services/SourceIntegrity.js";
import { SourceFileTypeDetector } from "../../services/SourceFileType.js";
import {
  downloadFile,
  filenameFromURL,
  resolveURLDownloadOptions,
} from "../../urlDownloads.js";
import {
  CLIError,
  VERSION,
  describeCliFailure,
  extractEnrichmentPreview,
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

const DOCUMENT_TITLE_EXTENSION_RE = /\.(pdf|md|markdown|docx|odt|fodt|txt)$/i;

interface AddCommandOptions extends Record<string, unknown> {
  tags?: string;
  title?: string;
  enrich?: boolean;
  visuals?: boolean;
  "auto-tag"?: boolean;
  provider?:
    | "ollama"
    | "gateway"
    | "openai"
    | "openai-codex"
    | "openrouter"
    | "google"
    | "anthropic";
}

function isURL(str: string): boolean {
  return str.startsWith("http://") || str.startsWith("https://");
}

function parseTags(tags: string | undefined): string[] | undefined {
  if (!tags) return undefined;
  return tags.split(",").map((tag) => tag.trim());
}

function toURLDownloadOptions(
  options: AddCommandOptions,
): Record<string, string | boolean> {
  return Object.fromEntries(
    Object.entries(options).filter(
      (entry): entry is [string, string | boolean] =>
        typeof entry[1] === "string" || typeof entry[1] === "boolean",
    ),
  );
}

export function runAddCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: AddCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library, globals }) =>
    Effect.gen(function* () {
      const pathOrUrl = args[1];
      if (!pathOrUrl) {
        yield* Console.error("Error: Path or URL required");
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", "Path or URL required", {
            command: "add",
          }),
        );
      }

      const tags = parseTags(options.tags);

      let localPath: string;
      let title = options.title;

      if (isURL(pathOrUrl)) {
        const appConfig = globals.config!;
        const config = LibraryConfig.fromConfig(appConfig);
        const downloadOptions = yield* Effect.try({
          try: () => resolveURLDownloadOptions(
            appConfig,
            toURLDownloadOptions(options),
            (code, message, details) => new CLIError(code, message, details),
          ),
          catch: (error) =>
            error instanceof CLIError
              ? error
              : new CLIError("INVALID_ARGS", describeCliFailure(error)),
        });
        const downloadsDir = join(config.libraryPath, "downloads");

        if (!existsSync(downloadsDir)) {
          mkdirSync(downloadsDir, { recursive: true });
        }

        const filename = filenameFromURL(pathOrUrl);
        localPath = join(downloadsDir, filename);

        if (!title) {
          title = basename(filename).replace(DOCUMENT_TITLE_EXTENSION_RE, "");
        }

        yield* Console.log(`Downloading: ${pathOrUrl}`);
        localPath = yield* downloadFile(
          pathOrUrl,
          downloadsDir,
          downloadOptions,
          `poink/${VERSION}`,
        );
        yield* Console.log(`  Saved to: ${localPath}`);
      } else {
        localPath = pathOrUrl;
      }

      const initialFingerprint = yield* fingerprintSource(localPath);
      const sourceTypeDetector = yield* SourceFileTypeDetector;
      const detected = yield* sourceTypeDetector.detect(localPath);
      yield* Console.log(`Adding: ${localPath}`);

      const autoTag = options["auto-tag"] === true;
      const enrich = options.enrich === true;
      const addConfig = globals.config!;
      const visualsExplicit = options.visuals === true;
      const visualsEnabled =
        visualsExplicit || resolveVisualsConfig(addConfig).enabled;
      const visualsMode = visualsEnabled
        ? visualsExplicit
          ? "explicit"
          : "config"
        : undefined;
      const forceProvider = options.provider;
      let enrichedTitle = title;
      let enrichedTags = tags ?? [];
      let enrichment: EnrichmentResult | undefined;

      if (autoTag || enrich) {
        const tagger = yield* AutoTagger;
        const pdfExtractor = yield* PDFExtractor;
        const officeExtractor = yield* OfficeExtractor;
        const content = yield* extractEnrichmentPreview(localPath, {
          enrich,
          detected,
          pdfExtractor,
          officeExtractor,
        });

        if (enrich && content) {
          const providerLabel = forceProvider || "auto";
          yield* Console.log(`  Enriching with LLM (${providerLabel})...`);
          const enrichResult = yield* tagger.enrich(localPath, content, {
            provider: forceProvider,
          });
          enrichment = enrichResult;
          enrichedTitle = enrichedTitle || enrichResult.title;
          enrichedTags = [...enrichedTags, ...enrichResult.tags];
          yield* Console.log(`  Title: ${enrichResult.title}`);
          yield* Console.log(`  Summary: ${enrichResult.summary}`);
          if (enrichResult.proposedConcepts?.length) {
            yield* Console.log(
              `  Proposed ${enrichResult.proposedConcepts.length} concept(s)`,
            );
          }
        } else if (enrich && !content) {
          yield* Console.log("  No content extracted, using heuristics");
          const tagResult = yield* tagger.generateTags(localPath, undefined, {
            heuristicsOnly: true,
          });
          enrichedTags = [...enrichedTags, ...tagResult.allTags];
        } else {
          yield* Console.log("  Auto-tagging...");
          const tagResult = yield* tagger.generateTags(localPath, content, {
            heuristicsOnly: !content,
          });
          enrichedTags = [...enrichedTags, ...tagResult.allTags];
        }
      }

      const addOptions = new AddOptions({
        title: enrichedTitle,
        tags: enrichedTags.length > 0 ? enrichedTags : undefined,
        visuals: visualsEnabled ? true : undefined,
        visualsMode,
        sourceContext: {
          initialFingerprint,
          detectedType: detected,
        },
      });
      const doc = yield* library.add(
        localPath,
        addOptions,
      );
      if (enrichment?.proposedConcepts?.length) {
        const tagger = yield* AutoTagger;
        const acceptance = yield* Effect.either(
          tagger.acceptProposals(enrichment.proposedConcepts),
        );
        if (acceptance._tag === "Right") {
          yield* Console.log(
            `  Accepted ${acceptance.right.accepted} concept(s)`,
          );
        } else {
          yield* Console.log(
            "  WARN Document added, but concept acceptance failed",
          );
        }
      }
      yield* Console.log(`OK Added: ${doc.title}`);
      yield* Console.log(`  ID: ${doc.id}`);
      yield* Console.log(`  Pages: ${doc.pageCount}`);
      yield* Console.log(
        `  Size: ${(doc.sizeBytes / 1024 / 1024).toFixed(2)} MB`,
      );
      if (doc.tags.length) yield* Console.log(`  Tags: ${doc.tags.join(", ")}`);
      return {
        resultPayload: doc,
        agentResult: { _tag: "add" as const, title: doc.title, id: doc.id },
      };
    }),
    options);
}
