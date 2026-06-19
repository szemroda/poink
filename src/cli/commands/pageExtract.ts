import { Effect } from "effect";
import type { OutputFormat } from "../../agent/protocol.js";
import {
  extractStoredPdfPages,
  isSafeDocumentId,
  PageExtractionError,
  parsePageExportFormats,
  parsePageSelector,
  parsePngWidth,
} from "../../services/PageExtraction.js";
import {
  SourceFileChangedError,
  SourceFileUnavailableError,
  SourceFileUnreadableError,
  type SourceIdentity,
  type StoredSourceIdentity,
} from "../../services/SourceIntegrity.js";
import { CLIError, type CliLibrary } from "../runner.js";
import type { CliCommandOutput, CliConsole } from "./types.js";

export type PageExtractLibrary = Pick<
  CliLibrary,
  "getWithSourceIdentity"
>;

type PageExtractOptionKey =
  | "outputFormat"
  | "outputDir"
  | "pngWidth"
  | "output-format"
  | "output-dir"
  | "png-width";

function stringOption(
  options: Readonly<Record<string, unknown>>,
  camelCase: PageExtractOptionKey,
  kebabCase: PageExtractOptionKey,
): string | undefined {
  const value = options[camelCase] ?? options[kebabCase];
  return typeof value === "string" ? value : undefined;
}

function parseExtractionOptions(
  selector: string,
  options: Readonly<Record<string, unknown>>,
) {
  try {
    const selection = parsePageSelector(selector);
    const outputFormats = parsePageExportFormats(
      stringOption(options, "outputFormat", "output-format"),
    );
    return {
      selection,
      outputFormats,
      outputDirectory: stringOption(
        options,
        "outputDir",
        "output-dir",
      ),
      pngWidth: parsePngWidth(
        options.pngWidth ?? options["png-width"],
        outputFormats,
      ),
    };
  } catch (error) {
    if (error instanceof PageExtractionError) {
      throw new CLIError(error._tag, error.message);
    }
    throw error;
  }
}

function requireSourceIdentity(
  storedIdentity: StoredSourceIdentity,
): SourceIdentity {
  if (storedIdentity.status === "missing") {
    throw new CLIError(
      "SOURCE_IDENTITY_MISSING",
      "Stored source identity is missing",
    );
  }
  if (storedIdentity.status === "invalid") {
    throw new CLIError(
      "SOURCE_IDENTITY_INVALID",
      "Stored source identity is invalid",
    );
  }
  return storedIdentity.identity;
}

type ExtractionFailure =
  | PageExtractionError
  | SourceFileUnavailableError
  | SourceFileUnreadableError
  | SourceFileChangedError;

function extractionFailure(error: unknown): ExtractionFailure {
  if (
    error instanceof PageExtractionError ||
    error instanceof SourceFileUnavailableError ||
    error instanceof SourceFileUnreadableError ||
    error instanceof SourceFileChangedError
  ) {
    return error;
  }
  return new PageExtractionError(
    "PAGE_EXTRACTION_FAILED",
    "Page extraction failed",
  );
}

export function runPageExtractCommand(
  args: string[],
  format: OutputFormat,
  library: PageExtractLibrary,
  Console: CliConsole,
  rawOptions: Record<string, unknown>,
): Effect.Effect<CliCommandOutput, unknown, never> {
  return Effect.gen(function* () {
    const docId = args[2];
    const selectorValue = args[3];
    if (!docId || !selectorValue) {
      return yield* Effect.fail(
        new CLIError(
          "INVALID_ARGS",
          "Usage: poink page extract <docId> <pages> [options]",
        ),
      );
    }

    const parsedOptions = yield* Effect.try({
      try: () => parseExtractionOptions(selectorValue, rawOptions),
      catch: (error) =>
        error instanceof CLIError
          ? error
          : new CLIError("INVALID_ARGS", "Invalid page extraction options"),
    });

    const stored = yield* library.getWithSourceIdentity(docId);
    if (!stored) {
      return yield* Effect.fail(
        new CLIError("NOT_FOUND", `Document not found: ${docId}`),
      );
    }
    if (stored.document.fileType !== "pdf") {
      return yield* Effect.fail(
        new CLIError(
          "UNSUPPORTED_FILE_TYPE",
          "Page extraction supports stored PDF documents only",
        ),
      );
    }
    if (!isSafeDocumentId(stored.document.id)) {
      return yield* Effect.fail(
        new CLIError(
          "UNSAFE_DOCUMENT_ID",
          "Document ID is not safe for export filenames",
        ),
      );
    }
    const sourceIdentity = yield* Effect.try({
      try: () => requireSourceIdentity(stored.sourceIdentity),
      catch: (error) =>
        error instanceof CLIError
          ? error
          : new CLIError("SOURCE_IDENTITY_INVALID", "Invalid source identity"),
    });

    const result = yield* Effect.tryPromise({
      try: () =>
        extractStoredPdfPages(
          stored.document,
          sourceIdentity,
          parsedOptions.selection,
          {
            outputFormats: parsedOptions.outputFormats,
            pngWidth: parsedOptions.pngWidth,
            outputDirectory: parsedOptions.outputDirectory,
          },
        ),
      catch: extractionFailure,
    });

    if (format === "text") {
      yield* Console.log(`Exported pages: ${result.pages.join(",")}`);
      for (const path of result.files) yield* Console.log(path);
    }
    return { resultPayload: result, agentResult: null };
  });
}
