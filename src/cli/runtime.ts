import { Effect, Layer, Logger } from "effect";
import { mkdirSync } from "node:fs";
import type { Config } from "../types.js";
import { resolveLibraryPath } from "../types.js";
import type { LogLevel } from "../agent/protocol.js";
import { toEffectLogLevel } from "../logger.js";

export function withConfiguredLogging<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  logLevel: LogLevel,
): Effect.Effect<A, E, R> {
  return effect.pipe(Logger.withMinimumLogLevel(toEffectLogLevel(logLevel)));
}

export async function buildStoreLayer(config: Config) {
  mkdirSync(resolveLibraryPath(config), { recursive: true });
  const [{ makeStorageLayer }, { makeLibraryStore }] = await Promise.all([
    import("../services/StorageLayer.js"),
    import("../services/LibraryStore.js"),
  ]);
  const storage = makeStorageLayer(config);
  return makeLibraryStore(config).pipe(Layer.provide(storage));
}

export async function buildSearchLayer(config: Config) {
  mkdirSync(resolveLibraryPath(config), { recursive: true });
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
  mkdirSync(resolveLibraryPath(config), { recursive: true });
  const [
    { makeStorageLayer },
    { makeEmbeddingProvider },
    { makeLibraryStore },
    { makeSemanticLibrary },
    { makeDocumentIngestion },
    { makePDFExtractor },
    { makeMarkdownExtractor },
    { makeOfficeExtractor },
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
  const extractors = Layer.mergeAll(
    pdfExtractor,
    markdownExtractor,
    officeExtractor,
  );
  const visuals = makeVisualEnrichment(config).pipe(
    Layer.provide(Layer.merge(pdfExtractor, officeExtractor)),
  );
  const ingestionDependencies = Layer.mergeAll(
    storage,
    embedding,
    extractors,
    visuals,
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
    autoTagger,
  );
}

export async function buildDiagnosticsLayer(config: Config) {
  mkdirSync(resolveLibraryPath(config), { recursive: true });
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
