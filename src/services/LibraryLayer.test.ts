import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Config } from "../types.js";
import { removeDirWithRetries } from "../testUtils.js";
import { DocumentIngestion } from "./DocumentIngestion.js";
import { EmbeddingProvider } from "./EmbeddingProvider.js";
import { makeLibraryLayer } from "./LibraryLayer.js";
import { LibraryStore } from "./LibraryStore.js";
import { SemanticLibrary } from "./SemanticLibrary.js";
import { TaxonomyService } from "./TaxonomyService.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await removeDirWithRetries(directory);
  }
});

test("makeLibraryLayer exposes the complete library surface over one storage layer", async () => {
  const libraryPath = mkdtempSync(join(tmpdir(), "poink-library-layer-"));
  tempDirs.push(libraryPath);
  const config = new Config({
    ...Config.Default,
    library: { path: libraryPath },
    storage: { libsql: { url: ":memory:" } },
  });

  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* LibraryStore;
        const taxonomy = yield* TaxonomyService;
        yield* DocumentIngestion;
        yield* SemanticLibrary;
        yield* EmbeddingProvider;

        yield* taxonomy.addConcept({
          id: "architecture",
          prefLabel: "Architecture",
        });
        return {
          stats: yield* store.stats(),
          concept: yield* taxonomy.getConcept("architecture"),
        };
      }).pipe(Effect.provide(makeLibraryLayer(config))),
    ),
  );

  expect(result.stats).toMatchObject({
    documents: 0,
    chunks: 0,
    embeddings: 0,
  });
  expect(result.concept?.prefLabel).toBe("Architecture");
});
