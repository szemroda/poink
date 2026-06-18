export * from "./types.js";
export { makeStorageLayer } from "./services/StorageLayer.js";
export { makeLibraryLayer } from "./services/LibraryLayer.js";
export {
  DocumentIntegrityRepository,
  DocumentRepository,
  LibraryMaintenance,
  SearchRepository,
  StorageError,
  type ChunkInput,
  type DocumentIntegrityRepositoryService,
  type DocumentRepositoryService,
  type DocumentWithSourceIdentity,
  type EmbeddingInput,
  type LibraryMaintenanceService,
  type SearchRepositoryService,
} from "./services/StorageRepositories.js";
export type {
  SourceIdentity,
  StoredSourceIdentity,
} from "./services/SourceIntegrity.js";
export {
  TaxonomyService,
  TaxonomyError,
  type Concept,
  type ConceptAssignment,
  type CreateConceptParams,
  type TaxonomyJSON,
  type UpdateConceptParams,
} from "./services/TaxonomyService.js";
export {
  DocumentIngestion,
  makeDocumentIngestion,
  type DocumentIngestionService,
} from "./services/DocumentIngestion.js";
export {
  LibraryStore,
  makeLibraryStore,
  type LibraryStoreService,
} from "./services/LibraryStore.js";
export {
  SemanticLibrary,
  makeSemanticLibrary,
  type SemanticLibraryService,
} from "./services/SemanticLibrary.js";
export {
  EmbeddingProvider,
  makeEmbeddingProvider,
  type EmbeddingError,
} from "./services/EmbeddingProvider.js";
export {
  MarkdownExtractor,
  MarkdownExtractorLive,
} from "./services/MarkdownExtractor.js";
export { OfficeExtractor, OfficeExtractorLive } from "./services/OfficeExtractor.js";
export { PDFExtractor, PDFExtractorLive } from "./services/PDFExtractor.js";
export {
  SourceFileTypeDetector,
  SourceFileTypeDetectorLive,
  makeSourceFileTypeDetector,
  SourceFileTypeUndeterminedError,
  UnsupportedSourceFileTypeError,
  type DetectedSourceType,
  type OfficeDetectedSourceType,
  type OfficeSourceFormat,
  type SourceFormat,
} from "./services/SourceFileType.js";
export {
  VisualEnrichment,
  makeVisualEnrichment,
  type ExtractedDocumentImage,
  type VisualDescriptionChunk,
  type VisualsMode,
} from "./services/VisualEnrichment.js";
