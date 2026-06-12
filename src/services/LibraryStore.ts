import { Context, Effect, Layer } from "effect";
import {
  type Config,
  DocumentNotFoundError,
  LibraryConfig,
  SearchOptions,
} from "../types.js";
import {
  DocumentRepository,
  LibraryMaintenance,
  SearchRepository,
} from "./StorageRepositories.js";

const makeLibraryStoreService = (appConfig: Config) =>
  Effect.gen(function* () {
    const documents = yield* DocumentRepository;
    const search = yield* SearchRepository;
    const maintenance = yield* LibraryMaintenance;
    const config = LibraryConfig.fromConfig(appConfig);

    const get = (idOrTitle: string) =>
      Effect.gen(function* () {
        const byId = yield* documents.getDocument(idOrTitle);
        if (byId) return byId;

        const docs = yield* documents.listDocuments();
        return (
          docs.find(
            (doc) =>
              doc.title.toLowerCase().includes(idOrTitle.toLowerCase()) ||
              doc.id.startsWith(idOrTitle),
          ) ?? null
        );
      });

    return {
      ftsSearch: (
        query: string,
        options: SearchOptions = new SearchOptions({}),
      ) => search.ftsSearch(query, options),
      getChunk: (chunkId: string) => documents.getChunk(chunkId),
      listChunksByDocument: (docId: string, opts?: { page?: number }) =>
        documents.listChunksByDocument(docId, opts),
      list: (tag?: string) => documents.listDocuments(tag),
      get,
      remove: (idOrTitle: string) =>
        Effect.gen(function* () {
          const doc = yield* get(idOrTitle);
          if (!doc) {
            return yield* new DocumentNotFoundError({ query: idOrTitle });
          }
          yield* documents.deleteDocument(doc.id);
          return doc;
        }),
      tag: (idOrTitle: string, tags: string[]) =>
        Effect.gen(function* () {
          const doc = yield* get(idOrTitle);
          if (!doc) {
            return yield* new DocumentNotFoundError({ query: idOrTitle });
          }
          yield* documents.updateTags(doc.id, tags);
          return doc;
        }),
      stats: () =>
        Effect.map(maintenance.getStats(), (stats) => ({
          ...stats,
          libraryPath: config.libraryPath,
        })),
      countChunksByDocumentIds: (docIds: string[]) =>
        maintenance.countChunksByDocumentIds(docIds),
      repair: () => maintenance.repair(),
      checkpoint: () => maintenance.checkpoint(),
    };
  });

export type LibraryStoreService = Effect.Effect.Success<
  ReturnType<typeof makeLibraryStoreService>
>;

export class LibraryStore extends Context.Tag("LibraryStore")<
  LibraryStore,
  LibraryStoreService
>() {}

export function makeLibraryStore(config: Config) {
  return Layer.effect(LibraryStore, makeLibraryStoreService(config));
}
