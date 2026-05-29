import { JSONSchema } from "effect";
import { Config } from "../types.js";
import { parseStringList } from "../urlDownloads.js";
import { CLIError, describeCliFailure } from "./runner.js";

export type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  enum?: unknown[];
};

export const CONFIG_JSON_SCHEMA = JSONSchema.make(Config as any) as JsonSchemaNode;

export function invalidConfigPathError(path: string): CLIError {
  return new CLIError("INVALID_ARGS", `Invalid config path: ${path}`, { path });
}

export function getConfigSchemaNode(path: string): JsonSchemaNode | undefined {
  if (!path) return undefined;

  let node: JsonSchemaNode | undefined = CONFIG_JSON_SCHEMA;
  for (const part of path.split(".")) {
    if (!part || !node?.properties || !(part in node.properties)) {
      return undefined;
    }
    node = node.properties[part];
  }

  return node;
}

export function parseConfigValue(
  path: string,
  rawValue: string,
  schemaNode: JsonSchemaNode,
): unknown {
  const trimmedValue = rawValue.trim();
  if (trimmedValue.toLowerCase() === "null" && schemaAcceptsNull(schemaNode)) {
    return null;
  }

  const types =
    typeof schemaNode.type === "string"
      ? [schemaNode.type]
      : Array.isArray(schemaNode.type)
        ? schemaNode.type
        : [];

  if (types.includes("object") || schemaNode.properties) {
    throw new CLIError(
      "INVALID_ARGS",
      `Config path must point to a scalar value: ${path}`,
      { path },
    );
  }

  if (types.includes("array")) {
    if (!schemaNode.items || schemaNode.items.type !== "string") {
      throw new CLIError(
        "INVALID_ARGS",
        `Config path does not support CLI array values: ${path}`,
        { path },
      );
    }
    try {
      return parseStringList(rawValue) ?? [];
    } catch (error) {
      throw new CLIError(
        "INVALID_ARGS",
        `Invalid array value for config path: ${path}`,
        { path, value: rawValue, reason: describeCliFailure(error) },
      );
    }
  }

  if (types.includes("boolean")) {
    const normalized = rawValue.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    throw new CLIError(
      "INVALID_ARGS",
      `Invalid boolean value for config path: ${path}`,
      { path, value: rawValue },
    );
  }

  if (types.includes("number") || types.includes("integer")) {
    const parsed = Number(rawValue);
    if (Number.isNaN(parsed)) {
      throw new CLIError(
        "INVALID_ARGS",
        `Invalid numeric value for config path: ${path}`,
        { path, value: rawValue },
      );
    }
    return parsed;
  }

  return rawValue;
}

const REDACTED_CONFIG_SECRET = "[redacted]";
const SECRET_CONFIG_KEYS = new Set([
  "apiKey",
  "authToken",
  "token",
  "password",
  "secret",
  "clientSecret",
]);

export function parseConfigOutputOptions(args: string[]): {
  args: string[];
  showSecrets: boolean;
} {
  let showSecrets = false;
  const filteredArgs: string[] = [];

  for (const arg of args) {
    if (arg === "--show-secrets" || arg === "--show-secrets=true") {
      showSecrets = true;
      continue;
    }
    if (arg === "--show-secrets=false") {
      continue;
    }
    filteredArgs.push(arg);
  }

  return { args: filteredArgs, showSecrets };
}

function isSecretConfigPath(path: string): boolean {
  const parts = path.split(".");
  const leaf = parts[parts.length - 1];
  return SECRET_CONFIG_KEYS.has(leaf);
}

export function redactConfigValue(
  path: string,
  value: unknown,
  showSecrets: boolean,
): unknown {
  if (showSecrets || value === undefined) {
    return value;
  }
  if (isSecretConfigPath(path)) {
    return REDACTED_CONFIG_SECRET;
  }
  if (value && typeof value === "object") {
    return redactConfigObject(value);
  }
  return value;
}

export function redactConfigObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactConfigObject(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SECRET_CONFIG_KEYS.has(key) && child !== undefined
        ? REDACTED_CONFIG_SECRET
        : redactConfigObject(child),
    ]),
  );
}

function schemaAcceptsNull(schemaNode: JsonSchemaNode): boolean {
  const types =
    typeof schemaNode.type === "string"
      ? [schemaNode.type]
      : Array.isArray(schemaNode.type)
        ? schemaNode.type
        : [];
  return (
    types.includes("null") ||
    Boolean(schemaNode.anyOf?.some((node) => schemaAcceptsNull(node)))
  );
}
