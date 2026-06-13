import {
  DEFAULT_CLI_OUTPUT_FORMAT,
  type AgentEnvelope,
  type OutputFormat,
  toJsonLine,
} from "../agent/protocol.js";

export function writeEnvelope<T>(
  format: OutputFormat,
  envelope: AgentEnvelope<T>,
  pretty: boolean,
): void {
  if (format === DEFAULT_CLI_OUTPUT_FORMAT) {
    return;
  }

  try {
    process.stdout.write(toJsonLine(envelope, { pretty }));
  } catch {
    // Envelope output is best-effort, including serialization and closed-pipe failures.
  }
}
