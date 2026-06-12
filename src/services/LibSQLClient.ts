import { createClient, type Client } from "@libsql/client";
import { Context, Effect, Layer } from "effect";
import {
  type Config,
  resolveLibsqlAuthToken,
  resolveLibsqlUrl,
} from "../types.js";
import { StorageError } from "./StorageRepositories.js";
import {
  classifyLibsqlUrl,
  createVectorSchemaManager,
  initializeLibSQLSchema,
  type LibSQLConnectionMode,
  type VectorSchemaManager,
} from "./LibSQLSchema.js";

export interface LibSQLClientService {
  readonly client: Client;
  readonly mode: LibSQLConnectionMode;
  readonly vectors: VectorSchemaManager;
}

export class LibSQLClient extends Context.Tag("LibSQLClient")<
  LibSQLClient,
  LibSQLClientService
>() {}

export function makeLibSQLClient(config: Config) {
  return Layer.scoped(
    LibSQLClient,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const url = resolveLibsqlUrl(config);
          const authToken = resolveLibsqlAuthToken(config);
          const mode = classifyLibsqlUrl(url);
          const client = createClient({ url, authToken });
          try {
            await initializeLibSQLSchema(client, mode);
            const vectors = createVectorSchemaManager(client);
            const storedDimension = await vectors.readDimension();
            if (storedDimension !== null) {
              await vectors.ensureForDimension(storedDimension);
            }
            return { client, mode, vectors };
          } catch (error) {
            client.close();
            throw error;
          }
        },
        catch: (error) =>
          error instanceof StorageError
            ? error
            : new StorageError({
                operation: "initialize libSQL storage",
                reason: error instanceof Error ? error.message : String(error),
              }),
      }),
      ({ client }) => Effect.sync(() => client.close()),
    ),
  );
}
