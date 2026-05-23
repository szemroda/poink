/**
 * Agent-optimized help text for poink.
 */

import dedent from "dedent";
import { DEFAULT_CLI_OUTPUT_FORMAT, OUTPUT_FORMATS } from "./protocol.js";

const OUTPUT_FORMAT_HELP = OUTPUT_FORMATS
  .map((format) =>
    format === DEFAULT_CLI_OUTPUT_FORMAT ? `${format} (default)` : format,
  )
  .join(", ");

export function renderHelp(stats?: {
  documents: number;
  chunks: number;
  embeddings: number;
}): string {
  const docCount = stats?.documents ?? "?";

  return dedent`
    # poink

    Local knowledge base for PDFs, Markdown, DOCX, and ODT with vector search, full-text search, enrichment, and MCP access.
    ${docCount} documents indexed.

    ## Quick Start
      poink search "your question here"

    ## Commands

    ### Search
      poink search "<query>" [options]
      poink search-pack "<q1>" "<q2>" ... [options]

    ### Read And Browse
      poink read "<id|title>"
      poink list [--tag <tag>]
      poink stats

    ### Progressive Disclosure
      poink chunk get <chunkId>
      poink doc chunks <docId> [--page N]
      poink page get <docId> <page>

    ### Taxonomy
      poink taxonomy search "<q>"
      poink taxonomy tree [id]
      poink taxonomy list [--tree]
      poink taxonomy add <id> --label "<name>" [--broader <parent>]

    ### Document Management
      poink add <path|url> [--tags t1,t2] [--enrich] [--auto-tag]
      poink add <url> [--max-file-size 100mb] [--download-timeout 30s] [--max-redirects 5]
      poink remove "<id|title>"
      poink tag "<id|title>" "tag1,tag2"
      poink ingest <dir> [--enrich] [--auto-tag] [--recursive]

    ### Maintenance
      poink capabilities
      poink mcp
      poink serve [--host <host>] [--port <port>] [--auth-token <token>]
      # Non-loopback HTTP binds require --auth-token, server.auth.token, or POINK_SERVER_TOKEN.
      poink doctor [--fix]
      poink repair
      poink config show|get|set [--show-secrets]
      poink --format text providers login --provider openai-codex [--device-auth]
      poink reindex [--clean]
      poink rechunk [--dry-run] [--include-missing] [--max-docs N] [--max-chunks N]

    ## Options
      --help, -h
      --version, -v
      --format <mode>       ${OUTPUT_FORMAT_HELP}
      --pretty
      --log-level <level>   silent (default), error, info, debug
      --quiet, --no-hints
  `;
}
