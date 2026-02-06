/**
 * Agent-optimized help text for pdf-brain.
 * Replaces the ASCII art banner with a rich, LLM-parseable reference.
 * Dynamic stats are injected at render time.
 */

/**
 * Generate the full help text with live stats injected.
 */
export function renderHelp(stats?: {
  documents: number;
  chunks: number;
  embeddings: number;
}): string {
  const docCount = stats?.documents ?? "?";

  return `# pdf-brain

Local knowledge base with vector search + full-text search over PDFs and Markdown.
${docCount} documents indexed. Every command returns contextual next-action hints.

## Quick Start
  pdf-brain search "your question here"

## Commands

### Search (primary entry point)
  pdf-brain search "<query>" [options]
    --limit <n>          Max results (default 10)
    --expand <chars>     Surrounding context (up to 4000 chars)
    --fts                Full-text search only (keyword matching)
    --concepts-only      Search taxonomy concepts only
    --docs-only          Search documents only
    --include-clusters   Include multi-scale cluster summaries

### Read & Browse
  pdf-brain read "<id|title>"       Document metadata (title, pages, tags, path)
  pdf-brain list [--tag <tag>]      All documents, optionally filtered by tag
  pdf-brain stats                   Library statistics (doc/chunk/embedding counts)

### Taxonomy (concept navigation)
  pdf-brain taxonomy search "<q>"   Find concepts by keyword or semantic similarity
  pdf-brain taxonomy tree [id]      Visual hierarchy tree from a concept
  pdf-brain taxonomy list [--tree]  All concepts (table or tree view)
  pdf-brain taxonomy add <id> --label "<name>" [--broader <parent>]

### Document Management
  pdf-brain add <path|url> [--tags t1,t2] [--no-enrich]
  pdf-brain remove "<id|title>"
  pdf-brain tag "<id|title>" "tag1,tag2"
  pdf-brain ingest <dir> [--enrich] [--auto-tag] [--recursive]

### Maintenance
  pdf-brain update                  Self-update to latest release
  pdf-brain doctor [--fix]          Health check (WAL, orphans, connectivity)
  pdf-brain config show|get|set     View/modify configuration
  pdf-brain reindex [--clean]       Re-embed all documents
  pdf-brain export / import         Backup and restore

## Agent Workflow
1. \`search\` -> find relevant chunks with similarity scores
2. \`search --expand 2000\` -> get full surrounding context for deeper reading
3. \`read\` -> get document metadata (title, tags, page count)
4. \`taxonomy search\` -> find concept categories, then \`taxonomy tree\` to navigate
5. \`list --tag\` -> discover documents by topic area

## Tips
- Scores closer to 1.0 = stronger semantic match
- Use --fts for exact keyword matching (skips embeddings)
- Concept IDs look like "programming/error-handling"
- --expand 2000 gives ~2000 chars of context around each match
- --quiet suppresses the next-action hints at the bottom
- Search returns both document chunks AND taxonomy concepts by default

## Options
  --help, -h            Show this help
  --version, -v         Show version
  --quiet, --no-hints   Suppress next-action hints`;
}
