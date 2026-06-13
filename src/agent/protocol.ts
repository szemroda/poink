/**
 * Agent-first output protocol for poink.
 *
 * Design goals:
 * - stdout is human-readable by default; JSON/NDJSON use a stable envelope
 * - stderr is diagnostics only (opt-in via log-level)
 * - stable envelope so agents can reliably parse responses and chain next actions
 */

import { isIP } from "node:net";

export const DEFAULT_CLI_OUTPUT_FORMAT = "text" as const;
export const OUTPUT_FORMATS = [DEFAULT_CLI_OUTPUT_FORMAT, "json", "ndjson"] as const;
export const DEFAULT_SERVER_AUTH_TOKEN_ENV = "POINK_SERVER_TOKEN" as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type LogLevel = "silent" | "error" | "info" | "debug";

export interface NextAction {
  kind: "shell";
  argv: string[];
  description?: string;
}

export interface AgentErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export interface TimingMeta {
  totalMs: number;
  commandMs?: number;
}

export interface AgentMeta {
  poinkVersion: string;
  timing: TimingMeta;
}

export interface ServerAuthConfig {
  enabled: boolean;
  token?: string;
  tokenEnv?: string;
}

export interface ServerConfigShape {
  host: string;
  port: number;
  auth: ServerAuthConfig;
}

export interface ServerConfigOverrides {
  host?: string;
  port?: number;
  authToken?: string;
}

export const DEFAULT_SERVER_CONFIG: ServerConfigShape = {
  host: "127.0.0.1",
  port: 3838,
  auth: {
    enabled: false,
    tokenEnv: DEFAULT_SERVER_AUTH_TOKEN_ENV,
  },
};

export type AgentEnvelope<T> =
  | {
      ok: true;
      command: string;
      result: T;
      nextActions?: NextAction[];
      meta?: AgentMeta;
    }
  | {
      ok: false;
      command: string;
      error: AgentErrorShape;
      nextActions?: NextAction[];
      meta?: AgentMeta;
    };

interface EnvelopeOptions {
  verbose?: boolean;
  meta?: AgentMeta;
}

interface SuccessEnvelopeOptions extends EnvelopeOptions {
  nextActions?: NextAction[];
}

function verboseMeta(options: EnvelopeOptions): Pick<AgentEnvelope<never>, "meta"> {
  if (!options.verbose || !options.meta) return {};
  return { meta: options.meta };
}

function verboseNextActions(
  options: SuccessEnvelopeOptions,
): Pick<AgentEnvelope<never>, "nextActions"> {
  if (!options.verbose || !options.nextActions) return {};
  return { nextActions: options.nextActions };
}

export function makeSuccessEnvelope<T>(
  command: string,
  result: T,
  options: SuccessEnvelopeOptions = {},
): AgentEnvelope<T> {
  return {
    ok: true,
    command,
    result,
    ...verboseNextActions(options),
    ...verboseMeta(options),
  };
}

export function makeErrorEnvelope(
  command: string,
  error: AgentErrorShape,
  options: EnvelopeOptions = {},
): AgentEnvelope<never> {
  const errorDetails =
    options.verbose && error.details !== undefined
      ? { details: error.details }
      : {};

  return {
    ok: false,
    command,
    error: {
      code: error.code,
      message: error.message,
      ...errorDetails,
    },
    ...verboseMeta(options),
  };
}

export function toJsonLine(
  value: unknown,
  opts?: { pretty?: boolean },
): string {
  const pretty = opts?.pretty === true;
  return JSON.stringify(value, null, pretty ? 2 : 0) + "\n";
}

export function resolveServerConfig(
  config: Partial<ServerConfigShape> | undefined,
  overrides?: ServerConfigOverrides,
): ServerConfigShape {
  const configuredAuth = config?.auth;
  const authTokenOverride = overrides?.authToken;
  const host = overrides?.host ?? config?.host ?? DEFAULT_SERVER_CONFIG.host;
  const port = overrides?.port ?? config?.port ?? DEFAULT_SERVER_CONFIG.port;
  const authEnabled =
    typeof authTokenOverride === "string"
      ? true
      : configuredAuth?.enabled ?? DEFAULT_SERVER_CONFIG.auth.enabled;
  const authToken = authTokenOverride ?? configuredAuth?.token;
  const authTokenEnv =
    configuredAuth?.tokenEnv ?? DEFAULT_SERVER_CONFIG.auth.tokenEnv;

  return {
    host,
    port,
    auth: {
      enabled: authEnabled,
      token: authToken,
      tokenEnv: authTokenEnv,
    },
  };
}

function normalizeBindHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = normalizeBindHost(host);
  if (normalized === "localhost") return true;

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return normalized.split(".")[0] === "127";
  }
  if (ipVersion === 6) {
    return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
  }

  return false;
}

export function requiresServerAuthForHost(host: string): boolean {
  return !isLoopbackBindHost(host);
}

export function resolveServerAuthToken(
  auth: ServerAuthConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (auth.token !== undefined) return auth.token;
  if (!auth.tokenEnv) return undefined;
  return env[auth.tokenEnv];
}

export function isBearerTokenAuthorized(
  headers: Headers,
  auth: ServerAuthConfig,
): boolean {
  if (!auth.enabled) return true;
  if (!auth.token) return false;

  const authorization = headers.get("authorization");
  if (!authorization) return false;

  return authorization === `Bearer ${auth.token}`;
}
