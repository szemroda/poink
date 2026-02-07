/**
 * Agent-first output protocol for pdf-brain.
 *
 * Design goals:
 * - stdout is machine-readable (JSON by default)
 * - stderr is diagnostics only (opt-in via log-level)
 * - stable envelope so agents can reliably parse responses and chain next actions
 */

export const PDF_BRAIN_PROTOCOL_VERSION = 1 as const;

export type OutputFormat = "json" | "ndjson" | "text";
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

export type AgentEnvelope<T> =
  | {
      ok: true;
      command: string;
      protocolVersion: typeof PDF_BRAIN_PROTOCOL_VERSION;
      result: T;
      nextActions?: NextAction[];
      meta?: Record<string, unknown>;
    }
  | {
      ok: false;
      command: string;
      protocolVersion: typeof PDF_BRAIN_PROTOCOL_VERSION;
      error: AgentErrorShape;
      nextActions?: NextAction[];
      meta?: Record<string, unknown>;
    };

export function toJsonLine(
  value: unknown,
  opts?: { pretty?: boolean }
): string {
  const pretty = opts?.pretty === true;
  return JSON.stringify(value, null, pretty ? 2 : 0) + "\n";
}

