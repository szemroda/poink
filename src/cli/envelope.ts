import { type AgentEnvelope, type OutputFormat, toJsonLine } from "../agent/protocol.js";

export function writeEnvelope<T>(
  format: OutputFormat,
  envelope: AgentEnvelope<T>,
  pretty: boolean,
): void {
  if (format === "text") return;
  try {
    process.stdout.write(toJsonLine(envelope, { pretty }));
  } catch {
    // ignore
  }
}
