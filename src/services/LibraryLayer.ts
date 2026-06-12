import { mkdirSync } from "node:fs";
import { Layer } from "effect";
import { resolveLibraryPath, type Config } from "../types.js";
import { makeAutoTagger } from "./AutoTagger.js";
import { makeDocumentIngestion } from "./DocumentIngestion.js";
import { makeEmbeddingProvider } from "./EmbeddingProvider.js";
import { makeLibraryStore } from "./LibraryStore.js";
import { makeMarkdownExtractor } from "./MarkdownExtractor.js";
import { makeOfficeExtractor } from "./OfficeExtractor.js";
import { makePDFExtractor } from "./PDFExtractor.js";
import { makeSemanticLibrary } from "./SemanticLibrary.js";
import { makeStorageLayer } from "./StorageLayer.js";
import { makeVisualEnrichment } from "./VisualEnrichment.js";
import { LibraryConfig } from "../types.js";

export function makeLibraryLayer(config: Config) {
  mkdirSync(resolveLibraryPath(config), { recursive: true });
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
  const ingestion = makeDocumentIngestion(config).pipe(
    Layer.provide(
      Layer.mergeAll(storage, embedding, extractors, visuals),
    ),
  );
  const store = makeLibraryStore(config).pipe(Layer.provide(storage));
  const semantic = makeSemanticLibrary(config).pipe(
    Layer.provide(Layer.merge(storage, embedding)),
  );

  return Layer.mergeAll(
    storage,
    store,
    semantic,
    ingestion,
    embedding,
    extractors,
    visuals,
    makeAutoTagger(config),
  );
}
