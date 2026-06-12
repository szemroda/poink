import { Layer } from "effect";
import type { Config } from "../types.js";
import { makeLibSQLClient } from "./LibSQLClient.js";
import { makeLibSQLRepositories } from "./LibSQLRepositories.js";
import { makeTaxonomyService } from "./TaxonomyService.js";

export function makeStorageLayer(config: Config) {
  const client = makeLibSQLClient(config);
  return Layer.merge(
    makeLibSQLRepositories(config),
    makeTaxonomyService({
      provider: config.models.embedding.provider,
      model: config.models.embedding.model,
    }),
  ).pipe(Layer.provide(client));
}
