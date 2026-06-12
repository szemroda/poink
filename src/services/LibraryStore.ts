import { Context, Effect, Layer } from "effect";
import {
  type Config,
  DocumentNotFoundError,
  LibraryConfig,
  SearchOptions,
} from "../types.js";
import { Database } from "./Database.js";

const makeLibraryStoreService = (appConfig: Config) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const config = LibraryConfig.fromConfig(appConfig);

    const get = (idOrTitle: string) =>
      Effect.gen(function* () {
        const byId = yield* db.getDocument(idOrTitle);
        if (byId) return byId;

        const docs = yield* db.listDocuments();
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
      ) => db.ftsSearch(query, options),
      getChunk: (chunkId: string) => db.getChunk(chunkId),
      listChunksByDocument: (docId: string, opts?: { page?: number }) =>
        db.listChunksByDocument(docId, opts),
      list: (tag?: string) => db.listDocuments(tag),
      get,
      remove: (idOrTitle: string) =>
        Effect.gen(function* () {
          const doc = yield* get(idOrTitle);
          if (!doc) {
            return yield* new DocumentNotFoundError({ query: idOrTitle });
          }
          yield* db.deleteDocument(doc.id);
          return doc;
        }),
      tag: (idOrTitle: string, tags: string[]) =>
        Effect.gen(function* () {
          const doc = yield* get(idOrTitle);
          if (!doc) {
            return yield* new DocumentNotFoundError({ query: idOrTitle });
          }
          yield* db.updateTags(doc.id, tags);
          return doc;
        }),
      stats: () =>
        Effect.map(db.getStats(), (stats) => ({
          ...stats,
          libraryPath: config.libraryPath,
        })),
      countChunksByDocumentIds: (docIds: string[]) =>
        db.countChunksByDocumentIds(docIds),
      repair: () => db.repair(),
      checkpoint: () => db.checkpoint(),
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
