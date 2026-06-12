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
  const [{ DatabaseRegistry }, { makeLibraryStore }] = await Promise.all([
    import("../services/DatabaseRegistry.js"),
    import("../services/LibraryStore.js"),
  ]);
  const database = DatabaseRegistry.make({ config });
  return makeLibraryStore(config).pipe(Layer.provide(database));
}

export async function buildSearchLayer(config: Config) {
  mkdirSync(resolveLibraryPath(config), { recursive: true });
  const [
    { DatabaseRegistry },
    { makeEmbeddingProvider },
    { makeLibraryStore },
    { makeSemanticLibrary },
    { TaxonomyServiceImpl },
  ] = await Promise.all([
    import("../services/DatabaseRegistry.js"),
    import("../services/EmbeddingProvider.js"),
    import("../services/LibraryStore.js"),
    import("../services/SemanticLibrary.js"),
    import("../services/TaxonomyService.js"),
  ]);
  const database = DatabaseRegistry.make({ config });
  const embedding = makeEmbeddingProvider(config);
  const store = makeLibraryStore(config).pipe(Layer.provide(database));
  const semantic = makeSemanticLibrary(config).pipe(
    Layer.provide(Layer.merge(database, embedding)),
  );
  const { LibraryConfig } = await import("../types.js");
  const libraryConfig = LibraryConfig.fromConfig(config);
  const taxonomy = TaxonomyServiceImpl.make({
    url: `file:${libraryConfig.dbPath}`,
  });
  return Layer.mergeAll(store, semantic, embedding, taxonomy);
}

export async function buildIngestionLayer(config: Config) {
  mkdirSync(resolveLibraryPath(config), { recursive: true });
  const [
    { DatabaseRegistry },
    { makeEmbeddingProvider },
    { makeLibraryStore },
    { makeSemanticLibrary },
    { makeDocumentIngestion },
    { makePDFExtractor },
    { makeMarkdownExtractor },
    { makeOfficeExtractor },
    { makeVisualEnrichment },
    { makeAutoTagger },
    { TaxonomyServiceImpl },
    { LibraryConfig },
  ] = await Promise.all([
    import("../services/DatabaseRegistry.js"),
    import("../services/EmbeddingProvider.js"),
    import("../services/LibraryStore.js"),
    import("../services/SemanticLibrary.js"),
    import("../services/DocumentIngestion.js"),
    import("../services/PDFExtractor.js"),
    import("../services/MarkdownExtractor.js"),
    import("../services/OfficeExtractor.js"),
    import("../services/VisualEnrichment.js"),
    import("../services/AutoTagger.js"),
    import("../services/TaxonomyService.js"),
    import("../types.js"),
  ]);

  const database = DatabaseRegistry.make({ config });
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
    database,
    embedding,
    extractors,
    visuals,
  );
  const ingestion = makeDocumentIngestion(config).pipe(
    Layer.provide(ingestionDependencies),
  );
  const store = makeLibraryStore(config).pipe(Layer.provide(database));
  const semantic = makeSemanticLibrary(config).pipe(
    Layer.provide(Layer.merge(database, embedding)),
  );
  const taxonomy = TaxonomyServiceImpl.make({
    url: `file:${libraryConfig.dbPath}`,
  });
  const autoTagger = makeAutoTagger(config);

  return Layer.mergeAll(
    store,
    semantic,
    ingestion,
    embedding,
    extractors,
    visuals,
    taxonomy,
    autoTagger,
  );
}

export async function buildDiagnosticsLayer(config: Config) {
  mkdirSync(resolveLibraryPath(config), { recursive: true });
  const [
    { DatabaseRegistry },
    { makeEmbeddingProvider },
    { makeLibraryStore },
    { TaxonomyServiceImpl },
    { LibraryConfig },
  ] = await Promise.all([
    import("../services/DatabaseRegistry.js"),
    import("../services/EmbeddingProvider.js"),
    import("../services/LibraryStore.js"),
    import("../services/TaxonomyService.js"),
    import("../types.js"),
  ]);
  const database = DatabaseRegistry.make({ config });
  const embedding = makeEmbeddingProvider(config);
  const store = makeLibraryStore(config).pipe(Layer.provide(database));
  const libraryConfig = LibraryConfig.fromConfig(config);
  const taxonomy = TaxonomyServiceImpl.make({
    url: `file:${libraryConfig.dbPath}`,
  });
  return Layer.mergeAll(store, embedding, taxonomy);
}

export async function buildFullServerLayer(config: Config) {
  return buildIngestionLayer(config);
}
