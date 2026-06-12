/**
 * Database Registry
 *
 * Selects and constructs the configured database backend.
 */

import {
  type Config,
  normalizeConfig,
  resolveLibsqlUrl,
  resolveStorageApiKey,
} from "../types.js";
import { Effect, Layer } from "effect";

export class DatabaseRegistry {
  static make(opts: { config: Config }) {
    return Layer.unwrapEffect(
      Effect.promise(async () => {
        const config = normalizeConfig(opts.config);

        switch (config.storage.backend) {
          case "qdrant": {
            const { QdrantDatabase } = await import("./QdrantDatabase.js");
            return QdrantDatabase.make({
              url: config.storage.qdrant.url,
              collection: config.storage.qdrant.collection,
              apiKey: resolveStorageApiKey(config.storage.qdrant),
            });
          }
          case "libsql":
          default: {
            const { LibSQLDatabase } = await import("./LibSQLDatabase.js");
            return LibSQLDatabase.make({
              url: resolveLibsqlUrl(config),
              authToken:
                config.storage.libsql.authToken ??
                (config.storage.libsql.authTokenEnv
                  ? process.env[config.storage.libsql.authTokenEnv]
                  : undefined),
              embeddingProvider: config.models.embedding.provider,
              embeddingModel: config.models.embedding.model,
            });
          }
        }
      }),
    );
  }
}
