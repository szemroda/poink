import { Context, Effect, Layer } from "effect";
import {
  AmbiguousDocumentError,
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
import { expandSearchResults } from "./SearchExpansion.js";

const makeLibraryStoreService = (appConfig: Config) =>
  Effect.gen(function* () {
    const documents = yield* DocumentRepository;
    const search = yield* SearchRepository;
    const maintenance = yield* LibraryMaintenance;
    const config = LibraryConfig.fromConfig(appConfig);

    /**
     * Resolves a user reference by exact ID, then exact title, then partial
     * title or ID prefix. Fails when the first matching tier is ambiguous.
     */
    const get = (idOrTitle: string) =>
      Effect.gen(function* () {
        const byId = yield* documents.getDocument(idOrTitle);
        if (byId) return byId;

        const docs = yield* documents.listDocuments();
        const needle = idOrTitle.toLowerCase();
        const exactTitles = docs.filter(
          (doc) => doc.title.toLowerCase() === needle,
        );
        const matches =
          exactTitles.length > 0
            ? exactTitles
            : docs.filter(
                (doc) =>
                  doc.title.toLowerCase().includes(needle) ||
                  doc.id.startsWith(idOrTitle),
              );
        if (matches.length <= 1) return matches[0] ?? null;

        return yield* new AmbiguousDocumentError({
          query: idOrTitle,
          reason: `"${idOrTitle}" matches ${matches.length} documents: ${matches
            .map((doc) => `${doc.id} (${doc.title})`)
            .join(", ")}. Use a document ID.`,
          candidates: matches.map((doc) => doc.id),
        });
      });

    return {
      ftsSearch: (
        query: string,
        options: SearchOptions = new SearchOptions({}),
      ) =>
        Effect.flatMap(search.ftsSearch(query, options), (results) =>
          expandSearchResults(results, options, search),
        ),
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
      relocate: (
        docId: string,
        newPath: string,
        options: { dryRun?: boolean } = {},
      ) =>
        Effect.gen(function* () {
          const doc = yield* documents.getDocument(docId);
          if (!doc) {
            return yield* new DocumentNotFoundError({ query: docId });
          }

          const oldPath = doc.path;
          const changed = oldPath !== newPath;
          if (changed && options.dryRun !== true) {
            yield* documents.updateDocumentPath(doc.id, newPath);
            yield* maintenance.checkpoint();
          }

          return {
            docId: doc.id,
            title: doc.title,
            oldPath,
            newPath,
            changed: changed && options.dryRun !== true,
          };
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
