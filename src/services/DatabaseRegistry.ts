/**
 * Database Registry
 *
 * Selects and constructs the configured database backend.
 */

import {
  type Config,
  loadConfig,
  normalizeConfig,
  resolveLibsqlUrl,
  resolveStorageApiKey,
} from "../types.js";
import { Effect, Layer } from "effect";
import { LibSQLDatabase } from "./LibSQLDatabase.js";
import { QdrantDatabase } from "./QdrantDatabase.js";

export class DatabaseRegistry {
  static make(opts?: { config?: Config }) {
    return Layer.unwrapEffect(
      Effect.sync(() => {
        const config = normalizeConfig(opts?.config ?? loadConfig());

        switch (config.storage.backend) {
          case "qdrant":
            return QdrantDatabase.make({
              url: config.storage.qdrant.url,
              collection: config.storage.qdrant.collection,
              apiKey: resolveStorageApiKey(config.storage.qdrant),
            });
          case "libsql":
          default:
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
      }),
    );
  }
}
