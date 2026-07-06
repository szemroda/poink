import { Effect, Layer, Logger } from "effect";
import { mkdirSync } from "node:fs";
import type { Config } from "../types.js";
import { resolveLibraryPath } from "../types.js";
import type { LogLevel } from "../agent/protocol.js";
import { toEffectLogLevel } from "../logger.js";

function ensureLibraryDirectory(config: Config): void {
  mkdirSync(resolveLibraryPath(config), { recursive: true });
}

export function withConfiguredLogging<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  logLevel: LogLevel,
): Effect.Effect<A, E, R> {
  return effect.pipe(Logger.withMinimumLogLevel(toEffectLogLevel(logLevel)));
}

export async function buildStoreLayer(config: Config) {
  ensureLibraryDirectory(config);
  const [{ makeStorageLayer }, { makeLibraryStore }] = await Promise.all([
    import("../services/StorageLayer.js"),
    import("../services/LibraryStore.js"),
  ]);
  const storage = makeStorageLayer(config);
  const store = makeLibraryStore(config).pipe(Layer.provide(storage));
  return Layer.merge(storage, store);
}

export async function buildSearchLayer(config: Config) {
  ensureLibraryDirectory(config);
  const [
    { makeStorageLayer },
    { makeEmbeddingProvider },
    { makeLibraryStore },
    { makeSemanticLibrary },
  ] = await Promise.all([
    import("../services/StorageLayer.js"),
    import("../services/EmbeddingProvider.js"),
    import("../services/LibraryStore.js"),
    import("../services/SemanticLibrary.js"),
  ]);
  const storage = makeStorageLayer(config);
  const embedding = makeEmbeddingProvider(config);
  const store = makeLibraryStore(config).pipe(Layer.provide(storage));
  const semantic = makeSemanticLibrary(config).pipe(
    Layer.provide(Layer.merge(storage, embedding)),
  );
  return Layer.mergeAll(storage, store, semantic, embedding);
}

export async function buildIngestionLayer(config: Config) {
  ensureLibraryDirectory(config);
  const [
    { makeStorageLayer },
    { makeEmbeddingProvider },
    { makeLibraryStore },
    { makeSemanticLibrary },
    { makeDocumentIngestion },
    { makePDFExtractor },
    { makeMarkdownExtractor },
    { makeOfficeExtractor },
    { makeTextExtractor },
    { SourceFileTypeDetectorLive },
    { makeVisualEnrichment },
    { makeAutoTagger },
    { LibraryConfig },
  ] = await Promise.all([
    import("../services/StorageLayer.js"),
    import("../services/EmbeddingProvider.js"),
    import("../services/LibraryStore.js"),
    import("../services/SemanticLibrary.js"),
    import("../services/DocumentIngestion.js"),
    import("../services/PDFExtractor.js"),
    import("../services/MarkdownExtractor.js"),
    import("../services/OfficeExtractor.js"),
    import("../services/TextExtractor.js"),
    import("../services/SourceFileType.js"),
    import("../services/VisualEnrichment.js"),
    import("../services/AutoTagger.js"),
    import("../types.js"),
  ]);

  const storage = makeStorageLayer(config);
  const embedding = makeEmbeddingProvider(config);
  const libraryConfig = LibraryConfig.fromConfig(config);
  const pdfExtractor = makePDFExtractor(libraryConfig);
  const markdownExtractor = makeMarkdownExtractor(libraryConfig);
  const officeExtractor = makeOfficeExtractor(libraryConfig);
  const textExtractor = makeTextExtractor(libraryConfig);
  const extractors = Layer.mergeAll(
    pdfExtractor,
    markdownExtractor,
    officeExtractor,
    textExtractor,
  );
  const visuals = makeVisualEnrichment(config).pipe(
    Layer.provide(Layer.merge(pdfExtractor, officeExtractor)),
  );
  const ingestionDependencies = Layer.mergeAll(
    storage,
    embedding,
    extractors,
    visuals,
    SourceFileTypeDetectorLive,
  );
  const ingestion = makeDocumentIngestion(config).pipe(
    Layer.provide(ingestionDependencies),
  );
  const store = makeLibraryStore(config).pipe(Layer.provide(storage));
  const semantic = makeSemanticLibrary(config).pipe(
    Layer.provide(Layer.merge(storage, embedding)),
  );
  const autoTagger = makeAutoTagger(config);

  return Layer.mergeAll(
    storage,
    store,
    semantic,
    ingestion,
    embedding,
    extractors,
    visuals,
    SourceFileTypeDetectorLive,
    autoTagger,
  );
}

export async function buildDiagnosticsLayer(config: Config) {
  ensureLibraryDirectory(config);
  const [
    { makeStorageLayer },
    { makeEmbeddingProvider },
    { makeLibraryStore },
  ] = await Promise.all([
    import("../services/StorageLayer.js"),
    import("../services/EmbeddingProvider.js"),
    import("../services/LibraryStore.js"),
  ]);
  const storage = makeStorageLayer(config);
  const embedding = makeEmbeddingProvider(config);
  const store = makeLibraryStore(config).pipe(Layer.provide(storage));
  return Layer.mergeAll(storage, store, embedding);
}

export async function buildFullServerLayer(config: Config) {
  return buildIngestionLayer(config);
}
