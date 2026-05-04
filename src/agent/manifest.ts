/**
 * Agent-optimized help text for pdf-brain.
 */

export function renderHelp(stats?: {
  documents: number;
  chunks: number;
  embeddings: number;
}): string {
  const docCount = stats?.documents ?? "?";

  return `# pdf-brain

Local knowledge base for PDFs and Markdown with vector search, full-text search, enrichment, and MCP access.
${docCount} documents indexed.

## Quick Start
  pdf-brain search "your question here"

## Commands

### Search
  pdf-brain search "<query>" [options]
  pdf-brain search-pack "<q1>" "<q2>" ... [options]

### Read And Browse
  pdf-brain read "<id|title>"
  pdf-brain list [--tag <tag>]
  pdf-brain stats

### Progressive Disclosure
  pdf-brain chunk get <chunkId>
  pdf-brain doc chunks <docId> [--page N]
  pdf-brain page get <docId> <page>

### Taxonomy
  pdf-brain taxonomy search "<q>"
  pdf-brain taxonomy tree [id]
  pdf-brain taxonomy list [--tree]
  pdf-brain taxonomy add <id> --label "<name>" [--broader <parent>]

### Document Management
  pdf-brain add <path|url> [--tags t1,t2] [--enrich] [--auto-tag]
  pdf-brain remove "<id|title>"
  pdf-brain tag "<id|title>" "tag1,tag2"
  pdf-brain ingest <dir> [--enrich] [--auto-tag] [--recursive]

### Maintenance
  pdf-brain capabilities
  pdf-brain mcp
  pdf-brain serve [--host <host>] [--port <port>] [--auth-token <token>]
  pdf-brain doctor [--fix]
  pdf-brain repair
  pdf-brain config show|get|set
  pdf-brain reindex [--clean]
  pdf-brain rechunk [--dry-run] [--include-missing] [--max-docs N] [--max-chunks N]

## Options
  --help, -h
  --version, -v
  --format <mode>       json (default), ndjson, text
  --pretty
  --log-level <level>   silent (default), error, info, debug
  --quiet, --no-hints`;
}
