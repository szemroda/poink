import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Effect } from "effect";

export type SourceIdentity = {
  algorithm: "sha256";
  hash: string;
};

export type SourceFingerprint = {
  identity: SourceIdentity;
  sizeBytes: number;
};

export type StoredSourceIdentity =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; identity: SourceIdentity };

export class SourceFileUnavailableError extends Error {
  readonly _tag = "SOURCE_FILE_UNAVAILABLE";

  constructor() {
    super("Source file is unavailable on this host");
  }
}

export class SourceFileUnreadableError extends Error {
  readonly _tag = "SOURCE_FILE_UNREADABLE";

  constructor() {
    super("Source file is unreadable or is not a regular file");
  }
}

export class SourceChangedDuringIngestionError extends Error {
  readonly _tag = "SOURCE_CHANGED_DURING_INGESTION";

  constructor() {
    super("Source file changed during ingestion");
  }
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return undefined;
  }
  return error.code;
}

function sourceReadError(
  error: unknown,
): SourceFileUnavailableError | SourceFileUnreadableError {
  return errorCode(error) === "ENOENT"
    ? new SourceFileUnavailableError()
    : new SourceFileUnreadableError();
}

export function fingerprintSource(
  path: string,
): Effect.Effect<
  SourceFingerprint,
  SourceFileUnavailableError | SourceFileUnreadableError
> {
  return Effect.tryPromise({
    try: async () => {
      let sourceStat;
      try {
        sourceStat = await stat(path);
      } catch (error) {
        throw sourceReadError(error);
      }

      if (!sourceStat.isFile()) {
        throw new SourceFileUnreadableError();
      }

      const hash = createHash("sha256");
      let sizeBytes = 0;
      try {
        for await (const chunk of createReadStream(path)) {
          const bytes =
            typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          sizeBytes += bytes.length;
          hash.update(bytes);
        }
      } catch (error) {
        throw sourceReadError(error);
      }

      return {
        identity: {
          algorithm: "sha256",
          hash: hash.digest("hex"),
        },
        sizeBytes,
      };
    },
    catch: (error) => {
      if (
        error instanceof SourceFileUnavailableError ||
        error instanceof SourceFileUnreadableError
      ) {
        return error;
      }
      return sourceReadError(error);
    },
  });
}

export function assertStableSource(
  initial: SourceFingerprint,
  final: SourceFingerprint,
): Effect.Effect<void, SourceChangedDuringIngestionError> {
  if (
    initial.identity.hash === final.identity.hash &&
    initial.sizeBytes === final.sizeBytes
  ) {
    return Effect.void;
  }
  return Effect.fail(new SourceChangedDuringIngestionError());
}

export function decodeStoredSourceIdentity(
  algorithm: unknown,
  hash: unknown,
): StoredSourceIdentity {
  if (algorithm === null && hash === null) return { status: "missing" };
  if (
    algorithm !== "sha256" ||
    typeof hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(hash)
  ) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    identity: { algorithm, hash },
  };
}
