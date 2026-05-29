import { Effect } from "effect";
import { existsSync, mkdirSync } from "fs";
import { basename, extname, join } from "path";
import { AddOptions, LibraryConfig } from "../../index.js";
import { resolveVisualsConfig, loadConfig } from "../../types.js";
import { AutoTagger } from "../../services/AutoTagger.js";
import { PDFExtractor } from "../../services/PDFExtractor.js";
import { OfficeExtractor } from "../../services/OfficeExtractor.js";
import { readFileText } from "../../runtime.js";
import {
  downloadFile,
  fileTypeFromExtension,
  filenameFromURL,
  resolveURLDownloadOptions,
  type ResolvedURLDownloadOptions,
} from "../../urlDownloads.js";
import {
  CLIError,
  VERSION,
  describeCliFailure,
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

const DOCUMENT_TITLE_EXTENSION_RE = /\.(pdf|md|markdown|docx|odt|fodt)$/i;
const ENRICHMENT_PREVIEW_MAX_CHARS = 8000;
const ENRICHMENT_PREVIEW_MAX_UNITS = 10;

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

function extractEnrichmentPreview(
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

export function runAddCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: AddCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library }) =>
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

      const opts = options;
      const tags = opts.tags
        ? (opts.tags as string).split(",").map((t) => t.trim())
        : undefined;

      let localPath: string;
      let title = opts.title as string | undefined;

      if (isURL(pathOrUrl)) {
        const config = LibraryConfig.fromEnv();
        const appConfig = loadConfig();
        let downloadOptions: ResolvedURLDownloadOptions;
        try {
          downloadOptions = resolveURLDownloadOptions(
            appConfig,
            opts as Record<string, string | boolean>,
            (code, message, details) => new CLIError(code, message, details),
          );
        } catch (error) {
          return yield* Effect.fail(
            error instanceof CLIError
              ? error
              : new CLIError("INVALID_ARGS", describeCliFailure(error)),
          );
        }
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

      yield* Console.log(`Adding: ${localPath}`);

      const autoTag = opts["auto-tag"] === true;
      const enrich = opts.enrich === true;
      const addConfig = loadConfig();
      const visualsExplicit = opts.visuals === true;
      const visualsEnabled =
        visualsExplicit || resolveVisualsConfig(addConfig).enabled;
      const visualsMode = visualsEnabled
        ? visualsExplicit
          ? "explicit"
          : "config"
        : undefined;
      const forceProvider = opts.provider;
      let enrichedTitle = title;
      let enrichedTags = tags || [];

      if (autoTag || enrich) {
        const tagger = yield* AutoTagger;
        const pdfExtractor = yield* PDFExtractor;
        const officeExtractor = yield* OfficeExtractor;
        const content = yield* extractEnrichmentPreview(localPath, {
          enrich,
          pdfExtractor,
          officeExtractor,
        });

        if (enrich && content) {
          const providerLabel = forceProvider || "auto";
          yield* Console.log(`  Enriching with LLM (${providerLabel})...`);
          const enrichResult = yield* tagger.enrich(localPath, content, {
            provider: forceProvider,
          });
          enrichedTitle = enrichedTitle || enrichResult.title;
          enrichedTags = [...enrichedTags, ...enrichResult.tags];
          yield* Console.log(`  Title: ${enrichResult.title}`);
          yield* Console.log(`  Summary: ${enrichResult.summary}`);
          if (
            enrichResult.proposedConcepts &&
            enrichResult.proposedConcepts.length > 0
          ) {
            yield* Console.log(
              `  Auto-accepted ${enrichResult.proposedConcepts.length} concept(s)`,
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

      const doc = yield* library.add(
        localPath,
        new AddOptions({
          title: enrichedTitle,
          tags: enrichedTags.length > 0 ? enrichedTags : undefined,
          visuals: visualsEnabled ? true : undefined,
          visualsMode,
        }),
      );
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
