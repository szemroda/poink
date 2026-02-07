# Agentic CLI Roadmap (Machine-Only Mode)

This CLI is not for humans. The only user is an agent (Codex/Claude/etc) invoking `pdf-brain` via shell or MCP and expecting deterministic, machine-readable output.

## Goal

Make `pdf-brain` a reliable "context engine" that agents can use to:

- Discover relevant sources fast
- Pull minimal snippets first, then expand on demand (progressive disclosure)
- Produce citation-ready evidence (title + page where available)
- Chain next actions without guessing (self-describing tools and schemas)

## Current Pain (Observed In Repo)

- `--quiet` does not actually quiet. Commands still emit headers/logs like `Searching: ...`, provider noise, and decorative formatting.
- stdout is polluted with operational logs (e.g. embedding dimension / provider detection), making parsing brittle.
- Human-centric formatting leaks everywhere (emoji, banners, TUI). Agents do not need that noise.
- Docs claim an MCP server (`pdf-brain mcp`) but the command is not implemented (tool contract mismatch is fatal for agents).

## Design Principles (Backed By Sources)

- stdout is for data, stderr is for diagnostics/errors, and non-zero exit codes signal failure.
  Source: Powerful Command-Line Applications in Go (p.66)
- CLIs should support explicit machine-readable output modes (plain text/JSON) and tailor output based on whether stdout is a TTY (human) or piped (machine).
  Source: Building Modern CLI Applications in Go (p.59, p.239)
- Tool design matters most for agent systems: detailed descriptions, specific input/output schemas, semantic naming.
  Source: Principles of Building AI Agents: 2nd Edition (p.21-22)
- If you want other agents to use your tool, ship an MCP server (standard way to expose tools to agents).
  Source: Principles of Building AI Agents: 2nd Edition (p.58)
- Prefer a single source of truth for types + runtime validation (avoid "types here, validation there" drift). JSON Schema is a common bridge.
  Source: Effective TypeScript, 2nd Edition (p.447, p.452)
- Progressive disclosure reduces token usage: keep the always-loaded contract small, load deeper context only when needed.
  Source: Complete Guide to Building Skills for Claude (p.29)
- Parallel work is fragile if subagents diverge; share context or keep workflows linear when needed.
  Source: Patterns for Building AI Agents (p.31)

## Output Contract (Proposed)

Every command returns a single JSON object to stdout (even on error) and uses exit codes for success/failure.

Top-level envelope:

```json
{
  "ok": true,
  "command": "search",
  "protocolVersion": 1,
  "result": {},
  "nextActions": [],
  "meta": {
    "pdfBrainVersion": "x.y.z",
    "timingMs": 12
  }
}
```

On error:

```json
{
  "ok": false,
  "command": "search",
  "protocolVersion": 1,
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Not found: ...",
    "details": {}
  },
  "nextActions": []
}
```

Notes:

- Human-readable strings can still exist, but only inside the structured object.
- stderr is reserved for debug logs, only when explicitly requested (e.g. `--log-level debug`).

## Status (As of 2026-02-07)

Implemented (agent-first behavior is now real, not aspirational):

- Default machine mode:
  - Global `--format json|ndjson|text` (default `json`)
  - `--pretty`, `--quiet/--no-hints`, `--log-level`
  - stdout discipline: JSON mode emits exactly one envelope object to stdout
- Score semantics are explicit: `scoreType`, `rawScore`, `matchType`, and normalized `score` (0..1).
- Discovery:
  - `pdf-brain capabilities` returns supported commands + JSON Schemas.
- Progressive disclosure primitives:
  - `pdf-brain chunk get <chunkId>`
  - `pdf-brain doc chunks <docId> [--page N]`
  - `pdf-brain page get <docId> <page>`
- Workflow power:
  - `pdf-brain search-pack` (multi-query args or stdin) with dedupe + aggregated JSON.
- MCP server:
  - `pdf-brain mcp` starts a stdio MCP server and exposes tools for search/read/list/chunk/page/taxonomy/doctor/rechunk.
- Chunker upgrade path:
  - New docs stamp `documents.metadata.chunker` so we can detect drift.
  - `pdf-brain rechunk --dry-run` shows what would be rebuilt (metadata mismatches).
  - `pdf-brain rechunk --dry-run --include-missing` includes legacy docs missing chunker metadata.
  - `pdf-brain doctor` warns when chunker metadata is missing/outdated and recommends rechunking.
  - `rechunk` uses an atomic in-place replace (doc upsert + chunk+embedding rebuild in one DB transaction) to avoid losing docs on failures.
- Reindex safety:
  - `pdf-brain reindex` re-embeds existing chunks in-place (no remove+add), using embedding upserts for atomic per-doc updates.

Next (still high ROI):

- Token-based chunking option (vs char-based) and version bump in `metadata.chunker` when shipped.
- Contract tests + golden envelopes per command (baseline contract tests now exist for envelope + capabilities + MCP).
- Query embedding cache tuning:
  - Implemented as an in-process LRU for `EmbeddingProvider.embed()` (MCP session speedup).
  - Next: add hit/miss counters in `meta` for debugging agent performance regressions.

## P0 (Highest Impact)

1. Implement global `--format`:
   - Default: `json` (agent-only mode)
   - `ndjson` for streaming workflows (ingest, pack, long-running tasks)
   - `text` only if we keep a human mode at all

2. Stop polluting stdout:
   - Route library/provider logs to stderr behind a log level.
   - `--quiet` must mean "data only" (no banners/headers/hints).

3. Fix score semantics (agents will automate against this):
   - Do not mix vector similarity (0..1) with FTS rank (unbounded).
   - Emit `{ matchType, score, scoreType }` where `scoreType` is explicit (`cosine_similarity`, `fts_rank`, etc).
   - If we must provide a single sortable number, compute a `normalizedScore` in a documented 0..1 range.

4. Make help self-describing:
   - `pdf-brain capabilities` outputs:
     - version
     - supported commands + flags
     - JSON Schemas for inputs/outputs
     - protocol version

5. Fix the MCP bullshit:
   - Either implement `pdf-brain mcp` or delete the claim from docs.
   - Prefer implementing MCP backed by the same schemas as CLI output.

6. Add progressive-disclosure primitives:
   - `pdf-brain chunk get <chunkId>`
   - `pdf-brain page get <docId> <page>`
   - `pdf-brain doc chunks <docId> [--page N]`
   These let agents start with tiny handles and expand only when needed.

7. Chunking v2 + rechunk path (this directly affects agent usefulness + DB size):
   - Preserve paragraph structure in PDF extraction and avoid nuking newlines.
   - Support token-based chunking as an option (token boundaries are often a better unit than characters).
   - Add a `rechunk` workflow to rebuild chunks + embeddings when the chunker changes.
   Sources:
   - AI Engineering: Building Applications with Foundation Models (p.638)
   - Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory (p.8)

## P1 (Workflow Power)

1. Query pack built-in:
   - `pdf-brain search-pack` accepts multiple queries (args or stdin)
   - runs semantic + FTS (configurable)
   - dedupes results
   - returns aggregated JSON + suggested follow-ups

2. Next actions become structured:
   - Replace string hints with `{ command, args, reason }`.

3. Contract tests:
   - For each command, run `--format json` and assert parseable + schema-valid.
   - Keep golden snapshots for stability across releases.

## P2 (Performance + Ergonomics For Agents)

- Persistent server mode (MCP server likely covers this): avoid cold-start costs for repeated tool calls.
- Caching query embeddings across a session (server-side) to reduce repeated embed calls.
- Add timings and trace metadata in `meta` to support agent-driven performance debugging.

## Repo Touchpoints

- `src/cli.ts`: parse global flags, route output through a single writer, enforce stdout/stderr rules.
- `src/agent/*`: convert hints/help into structured JSON; generate schemas/manifests.
- `src/types.ts`: use Effect Schema as the "single source of truth" for JSON Schema generation.
