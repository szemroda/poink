import { Schema } from "effect";

export class MarkdownNotFoundError extends Schema.TaggedError<MarkdownNotFoundError>()(
  "MarkdownNotFoundError",
  { path: Schema.String },
) {}

export class MarkdownExtractionError extends Schema.TaggedError<MarkdownExtractionError>()(
  "MarkdownExtractionError",
  { path: Schema.String, reason: Schema.String },
) {}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

const BOUNDARY_DETAIL_KEYS = [
  "operation",
  "path",
  "query",
  "command",
  "subcommand",
  "hint",
  "flag",
  "provider",
  "requestedRetrievalMode",
  "available",
  "commanderCode",
  "host",
  "tokenEnv",
  "configPath",
  "page",
  "docId",
  "rootId",
  "id",
  "idOrTitle",
] as const;

type BoundaryDetailValue = string | number | boolean | readonly string[];

function boundaryDetailValue(
  value: unknown,
): BoundaryDetailValue | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}

export function errorTag(error: unknown): string {
  return stringField(error, "_tag") ?? "UNKNOWN_ERROR";
}

export function describeError(error: unknown): string {
  const reason = stringField(error, "reason");
  const operation = stringField(error, "operation");
  if (reason && operation) return `${operation}: ${reason}`;
  if (reason) return reason;

  const path = stringField(error, "path");
  if (path) {
    return errorTag(error).includes("NotFound")
      ? `File not found: ${path}`
      : path;
  }

  const query = stringField(error, "query");
  if (query) return query;

  const message = stringField(error, "message");
  if (message) return message;

  return typeof error === "string" ? error : errorTag(error);
}

export function boundaryErrorDetails(
  error: unknown,
): Readonly<Record<string, BoundaryDetailValue>> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const tag = stringField(error, "tag") ?? errorTag(error);
  const details: Record<string, BoundaryDetailValue> =
    tag === "UNKNOWN_ERROR" ? {} : { tag };
  for (const key of BOUNDARY_DETAIL_KEYS) {
    const value = boundaryDetailValue(record[key]);
    if (value !== undefined) details[key] = value;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}
