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

type CapabilitiesCommandOptions = Record<string, unknown>;

interface CommandCapability {
  name: string;
  argv: string[];
  description: string;
}

function commandCapability(
  name: string,
  argv: string[],
  description: string,
): CommandCapability {
  return { name, argv, description };
}

function buildCapabilitiesResult() {
  return {
    poinkVersion: VERSION,
    outputFormats: OUTPUT_FORMATS,
    globalFlags: {
      "--format": OUTPUT_FORMATS,
      "--pretty": { type: "boolean", default: false },
      "--verbose": { type: "boolean", default: false },
      "--log-level": ["silent", "error", "info", "debug"] as const,
    },
    commands: [
      commandCapability(
        "search",
        ["search", "<query>"],
        "Hybrid document search and optional concept search; use --fts for explicit full-text retrieval",
      ),
      commandCapability(
        "search-pack",
        ["search-pack", "<query1>", "<query2>", "..."],
        "Multi-query hybrid search sweep + dedupe; use --fts for explicit full-text retrieval",
      ),
      commandCapability(
        "chunk",
        ["chunk", "get", "<chunkId>"],
        "Fetch a chunk's full text by ID (progressive disclosure)",
      ),
      commandCapability(
        "doc",
        ["doc", "chunks", "<docId>"],
        "List chunk IDs for a document (optionally by page)",
      ),
      commandCapability(
        "page",
        ["page", "get", "<docId>", "<page>"],
        "Reconstruct full page text by concatenating chunks",
      ),
      commandCapability(
        "read",
        ["read", "<id|title>"],
        "Read document metadata",
      ),
      commandCapability("list", ["list"], "List documents"),
      commandCapability("stats", ["stats"], "Library statistics"),
      commandCapability(
        "add",
        [
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
        "Add a local or URL document; URL downloads enforce SSRF protections, max file size, timeout, and redirect limits",
      ),
      commandCapability(
        "taxonomy",
        ["taxonomy", "<list|tree|get|search|add>"],
        "Taxonomy navigation and concept details (SKOS concepts)",
      ),
      commandCapability(
        "ingest",
        [
          "ingest",
          "<dir1>",
          "[dir2]",
          "[--enrich]",
          "[--visuals]",
          "[--auto-tag]",
          "[--tags <tags>]",
        ],
        "Add supported documents from one or more directories",
      ),
      commandCapability("doctor", ["doctor"], "Health check"),
      commandCapability(
        "rechunk",
        [
          "rechunk",
          "[--dry-run]",
          "[--doc <id>]",
          "[--tag <tag>]",
          "[--include-missing]",
          "[--max-docs <n>]",
          "[--max-chunks <n>]",
          "[--all]",
          "[--visuals]",
        ],
        "Rebuild chunks + embeddings when chunker changes (use --include-missing for legacy docs without metadata)",
      ),
      commandCapability(
        "reindex",
        ["reindex", "[--clean]", "[--doc <id>]"],
        "Re-embed existing chunks in-place (updates embeddings only; does NOT remove/re-add documents)",
      ),
      commandCapability(
        "config",
        ["config", "<show|get|set|schema>"],
        "Configuration and configuration schema",
      ),
      commandCapability(
        "providers",
        [
          "providers",
          "login",
          "--provider",
          "openai-codex",
          "--format",
          "text",
          "[--device-auth]",
        ],
        "Provider authentication helpers",
      ),
      commandCapability("mcp", ["mcp"], "Start MCP server (stdio)"),
      commandCapability(
        "serve",
        [
          "serve",
          "[--host <host>]",
          "[--port <port>]",
          "[--auth-token <token>]",
        ],
        `Start MCP server over HTTP (default ${DEFAULT_SERVER_CONFIG.host}:${DEFAULT_SERVER_CONFIG.port}; non-loopback hosts require bearer auth)`,
      ),
    ],
  };
}

export function runCapabilitiesCommand(
  args: string[],
  globals: GlobalCLIOptions,
  _options: CapabilitiesCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, format }) => {
    const result = buildCapabilitiesResult();

    return Effect.gen(function* () {
      if (format === "text") {
        yield* Console.log(JSON.stringify(result, null, 2));
      }
      return { resultPayload: result, agentResult: null };
    });
  });
}
