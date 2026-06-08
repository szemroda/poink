import { existsSync, mkdirSync } from "fs";
import { Effect, Layer, Logger } from "effect";
import { LibraryConfig, makePDFLibraryLive } from "../index.js";
import { AutoTaggerLive } from "../services/AutoTagger.js";
import { EmbeddingProviderFullLive } from "../services/EmbeddingProvider.js";
import { OfficeExtractorLive } from "../services/OfficeExtractor.js";
import { PDFExtractorLive } from "../services/PDFExtractor.js";
import { TaxonomyServiceImpl } from "../services/TaxonomyService.js";
import { toEffectLogLevel } from "../logger.js";
import type { LogLevel } from "../agent/protocol.js";

function ensureLibraryDirectoryExists(config: LibraryConfig): void {
  if (!existsSync(config.libraryPath)) {
    mkdirSync(config.libraryPath, { recursive: true });
  }
}

export function buildCliAppLayer() {
  const config = LibraryConfig.fromEnv();
  ensureLibraryDirectoryExists(config);

  const taxonomyServiceLive = TaxonomyServiceImpl.make({
    url: `file:${config.dbPath}`,
  });

  const pdfLibraryLive = makePDFLibraryLive();
  return Layer.merge(
    Layer.merge(
      Layer.merge(
        Layer.merge(pdfLibraryLive, AutoTaggerLive),
        PDFExtractorLive,
      ),
      OfficeExtractorLive,
    ),
    Layer.merge(taxonomyServiceLive, EmbeddingProviderFullLive),
  );
}

export function withConfiguredLogging<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  logLevel: LogLevel,
): Effect.Effect<A, E, R> {
  return effect.pipe(Logger.withMinimumLogLevel(toEffectLogLevel(logLevel)));
}

export function isServiceFreeCommand(command: string | undefined): boolean {
  return (
    command === "capabilities" ||
    command === "config" ||
    command === "providers" ||
    command === "setup"
  );
}
