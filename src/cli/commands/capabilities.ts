import { Effect } from "effect";
import {
  DEFAULT_SERVER_CONFIG,
  OUTPUT_FORMATS,
} from "../../agent/protocol.js";
import {
  VERSION,
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

interface CapabilitiesCommandOptions extends Record<string, unknown> {}

export function runCapabilitiesCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: CapabilitiesCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, format }) => {
    const result = {
      poinkVersion: VERSION,
      outputFormats: OUTPUT_FORMATS,
      globalFlags: {
        "--format": OUTPUT_FORMATS,
        "--pretty": { type: "boolean", default: false },
        "--verbose": { type: "boolean", default: false },
        "--log-level": ["silent", "error", "info", "debug"] as const,
      },
      commands: [
        { name: "search", argv: ["search", "<query>"], description: "Hybrid document search and optional concept search; use --fts for explicit full-text retrieval" },
        { name: "search-pack", argv: ["search-pack", "<query1>", "<query2>", "..."], description: "Multi-query hybrid search sweep + dedupe; use --fts for explicit full-text retrieval" },
        { name: "chunk", argv: ["chunk", "get", "<chunkId>"], description: "Fetch a chunk's full text by ID (progressive disclosure)" },
        { name: "doc", argv: ["doc", "chunks", "<docId>"], description: "List chunk IDs for a document (optionally by page)" },
        { name: "page", argv: ["page", "get", "<docId>", "<page>"], description: "Reconstruct full page text by concatenating chunks" },
        { name: "read", argv: ["read", "<id|title>"], description: "Read document metadata" },
        { name: "list", argv: ["list"], description: "List documents" },
        { name: "stats", argv: ["stats"], description: "Library statistics" },
        {
          name: "add",
          argv: [
            "add",
            "<path|url>",
            "[--tags <tags>]",
            "[--enrich]",
            "[--visuals]",
            "[--auto-tag]",
            "[--max-file-size <size>]",
            "[--download-timeout <duration>]",
            "[--max-redirects <n>]",
            "[--allow-private-network]",
            "[--allowed-private-network-hosts <hosts>]",
          ],
          description: "Add a local or URL document; URL downloads enforce SSRF protections, max file size, timeout, and redirect limits",
        },
        { name: "taxonomy", argv: ["taxonomy", "<list|tree|get|search|add>"], description: "Taxonomy navigation and concept details (SKOS concepts)" },
        {
          name: "ingest",
          argv: ["ingest", "<dir1>", "[dir2]", "[--enrich]", "[--visuals]", "[--auto-tag]", "[--tags <tags>]"],
          description: "Add supported documents from one or more directories",
        },
        { name: "doctor", argv: ["doctor"], description: "Health check" },
        {
          name: "rechunk",
          argv: ["rechunk", "[--dry-run]", "[--doc <id>]", "[--tag <tag>]", "[--include-missing]", "[--max-docs <n>]", "[--max-chunks <n>]", "[--all]", "[--visuals]"],
          description: "Rebuild chunks + embeddings when chunker changes (use --include-missing for legacy docs without metadata)",
        },
        { name: "reindex", argv: ["reindex", "[--clean]", "[--doc <id>]"], description: "Re-embed existing chunks in-place (updates embeddings only; does NOT remove/re-add documents)" },
        { name: "config", argv: ["config", "<show|get|set|schema>"], description: "Configuration and configuration schema" },
        {
          name: "providers",
          argv: ["providers", "login", "--provider", "openai-codex", "--format", "text", "[--device-auth]"],
          description: "Provider authentication helpers",
        },
        { name: "mcp", argv: ["mcp"], description: "Start MCP server (stdio)" },
        {
          name: "serve",
          argv: ["serve", "[--host <host>]", "[--port <port>]", "[--auth-token <token>]"],
          description: `Start MCP server over HTTP (default ${DEFAULT_SERVER_CONFIG.host}:${DEFAULT_SERVER_CONFIG.port}; non-loopback hosts require bearer auth)`,
        },
      ],
    };

    return Effect.gen(function* () {
      if (format === "text") {
        yield* Console.log(JSON.stringify(result, null, 2));
      }
      return { resultPayload: result, agentResult: null };
    });
  });
}
