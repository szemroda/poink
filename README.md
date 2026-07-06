# poink

Local-first **PDF, Markdown, TXT, DOCX, and ODT** knowledge base with semantic search and AI-powered enrichment.

## Features

- **PDF + Markdown + TXT + Office docs** - Index `.pdf`, `.md`, `.txt`, `.docx`, `.odt`, and `.fodt` files with the same workflow
- **Local-first by default** - Run with Ollama on your machine when you want no API costs
- **External provider support** - Use AI Gateway, OpenAI, OpenAI Codex, OpenRouter, Google, or Anthropic for hosted models
- **AI enrichment** - LLM extracts titles, summaries, tags, and concepts
- **SKOS taxonomy** - Organize documents with hierarchical concepts
- **Vector search** - Semantic search via embeddings
- **Hybrid search** - Combine vector similarity with full-text search
- **MCP server** - Use with Claude, Cursor, and other AI assistants

## Credits

poink started as a fork of the original [pdf-brain](https://github.com/joelhooks/pdf-brain) package. This project builds on that work while continuing under a new package name and CLI.

## Quick Start

> Note: `poink` emits human-readable text by default.  
> Use `--format json` for a single machine-readable envelope, or inspect the machine contract via `poink capabilities`.

```bash
# 1. Install from npm
npm install -g poink-cli

# 2. Guided setup (choose providers, creates DB, seeds starter taxonomy)
poink setup init

# 3. Add your first document
poink add ~/Documents/paper.pdf --enrich
```

## Installation

### Prerequisites

poink requires Node.js 22.22.1 or newer.

The setup wizard lets you choose local or hosted providers for embeddings, enrichment, and judging:

- **Ollama** for a local-first setup with no API costs
- **AI Gateway**, **OpenAI**, **OpenRouter**, or **Google** for hosted embeddings
- **AI Gateway**, **OpenAI**, **OpenAI Codex**, **OpenRouter**, **Google**, or **Anthropic** for hosted enrichment and judging

If you choose a hosted provider, have the matching API key or environment variable ready. If you choose OpenAI Codex, the wizard can run browser or device-code OAuth after applying your config.

Ollama is only required for the default local setup:

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows
# Download from https://ollama.com/download
```

### Models

```bash
# Required for the default local embedding setup (1024 dimensions)
ollama pull mxbai-embed-large

# Recommended for local enrichment
ollama pull llama3.2:3b

# Start Ollama server
ollama serve
```

### Install poink

```bash
npm install -g poink-cli
```

### Agent Skill

Install the poink semantic search skill with [skills.sh](https://skills.sh/):

```bash
npx skills add https://github.com/szemroda/poink --skill poink-semantic-search
```

## CLI Reference

### Output Format

`poink` uses human-readable text by default. JSON and NDJSON remain available for scripts and agents.

- `--format text|json|ndjson` (default: `text`)
- `--pretty` pretty-print JSON
- `--verbose` include metadata, next actions, and command diagnostics in structured output
- `--log-level silent|error|info|debug` (logs go to stderr)

You can change the CLI default format in config:

```bash
poink config set cli.globalFlags.format json
poink config set cli.globalFlags.format text
```

Discover the command and tool contract at runtime:

```bash
poink capabilities
```

Inspect the configuration JSON Schema separately:

```bash
poink config schema
```

### Basic Commands

```bash
# Check the configured embedding provider
poink check

# Show library stats
poink stats

# Guided first-time setup
poink setup init

# Guided reconfiguration for an initialized library
poink setup config

# Non-interactive initializer for scripts and agents (creates DB, seeds taxonomy)
poink init
```

### MCP Access

```bash
# Start MCP over stdio (for local tool runners)
poink mcp

# Start MCP over HTTP
poink serve

# Bind to a custom interface/port
poink serve --host 127.0.0.1 --port 3838

# Require a bearer token for /mcp
poink serve --auth-token your-token

# Bind outside loopback with bearer auth
POINK_SERVER_TOKEN=your-token poink serve --host 0.0.0.0
```

`poink serve` exposes `/health` for readiness checks and `/mcp` for the HTTP MCP endpoint. The default bind is `127.0.0.1:3838`. Non-loopback binds, including `0.0.0.0`, `::`, LAN IPs, and named hosts, require bearer auth and fail at startup unless a token is available from `--auth-token`, `server.auth.token`, or `server.auth.tokenEnv` (default: `POINK_SERVER_TOKEN`).

### Adding Documents

```bash
# Add a PDF
poink add /path/to/document.pdf

# Add a Markdown file
poink add /path/to/notes.md

# Add a plain text file
poink add /path/to/notes.txt

# Add Word or OpenDocument text files
poink add /path/to/report.docx
poink add /path/to/notes.odt

# Add from URL (supported document formats)
poink add https://example.com/paper.pdf
poink add https://raw.githubusercontent.com/user/repo/main/README.md

# Override URL download limits for this command
poink add https://example.com/large-report.pdf --max-file-size 250mb --download-timeout 1m

# Allow a specific internal document host that resolves to a private IP
poink add https://docs.internal/report.pdf --allowed-private-network-hosts docs.internal

# Add with manual tags
poink add document.pdf --tags "ai,agents,research"

# Add with auto-tagging only (faster)
poink add document.pdf --auto-tag

# Add with AI enrichment (extracts title, summary, concepts)
poink add document.pdf --enrich
poink add notes.md --enrich
poink add report.docx --enrich

# Add searchable descriptions for embedded PDF/DOCX visuals
poink add document.pdf --visuals
poink add document.pdf --enrich --visuals
```

If a source file is moved after ingestion, update the stored document path
without re-ingesting:

```bash
poink doc relocate <docId> /new/path/to/document.pdf
poink doc relocate <docId> /new/path/to/document.pdf --dry-run
```

URL downloads are guarded by default. poink blocks private, loopback, link-local,
and reserved network destinations, validates each redirect target, enforces
`ingest.urlDownloads.maxFileSize`, and aborts downloads after
`ingest.urlDownloads.timeout`. `maxFileSize` must be a string with a size suffix
such as `500kb`, `100mb`, or `1gb`; `timeout` must be a string such as `500ms`,
`30s`, or `2m`. For trusted internal document hosts, prefer
`--allowed-private-network-hosts <host>` or
`ingest.urlDownloads.allowedPrivateNetworkHosts` over the broader
`--allow-private-network` escape hatch.

### Searching

```bash
# Semantic search (uses embeddings)
poink search "context engineering patterns"

# Full-text search only (faster, no embeddings)
poink search "context engineering" --fts

# Search only documents or only taxonomy concepts
poink search "machine learning" --docs-only
poink search "machine learning" --concepts-only

# Limit results
poink search "query" --limit 5

# Expand context around matches
poink search "query" --expand 500

# Include cluster summaries when available
poink search "query" --include-clusters
```

### Managing Documents

```bash
# List all documents
poink list

# List by tag
poink list --tag ai

# Get document details
poink read "document-title"

# Remove a document
poink remove "document-title"

# Update tags
poink tag "document-title" "new,tags,here"
```

### Exporting PDF Pages

Export selected pages from a stored PDF as a smaller PDF, individual PNG
images, or both. Use the exact document ID shown by `poink list` or
`poink read`.

```bash
# Export page 4 as a PDF
poink page extract abc123 4

# Export individual pages and inclusive ranges
poink page extract abc123 2,5-7

# Render one PNG per selected page
poink page extract abc123 2-5 --output-format png

# Export both formats into a chosen directory
poink page extract abc123 2-5 \
  --output-format pdf,png \
  --output-dir ./exports \
  --png-width 2000
```

Page selections are normalized into ascending order and may contain individual
page numbers or inclusive ranges. Descending ranges are accepted, duplicates
are removed, and page numbers refer to the original PDF.

`--output-format` defaults to `pdf`. When `--output-dir` is omitted, artifacts
are written to a managed temporary directory and their absolute paths are
printed. `--png-width` defaults to `1600` and is valid only when PNG output is
requested. Page extraction currently supports stored PDF documents only.

### Taxonomy Commands

The taxonomy system uses SKOS (Simple Knowledge Organization System) for hierarchical concept organization.

```bash
# List all concepts
poink taxonomy list

# Show concept tree
poink taxonomy tree

# Show subtree from a concept
poink taxonomy tree programming

# Get full concept details and relationships
poink taxonomy get programming

# Search concepts
poink taxonomy search "machine learning"

# Add a new concept
poink taxonomy add programming/transformers --label "Transformers" --broader programming/ai-ml

# Add alternate labels and a definition
poink taxonomy add ai/rag --label "RAG" --broader programming/ai-ml --definition "Retrieval-augmented generation" --alt-labels "retrieval augmented generation"
```

### Bulk Ingest

Recursively ingest directories containing supported document files:

```bash
# Ingest a directory with full LLM enrichment
poink ingest ~/Documents/papers --enrich

# Ingest your Obsidian vault or notes folder
poink ingest ~/Documents/obsidian --enrich

# Ingest multiple directories (PDFs, Markdown, DOCX/ODT, mixed)
poink ingest ~/papers ~/books ~/notes --enrich

# With manual tags
poink ingest ~/books --tags "books,reference"

# Auto-tag only (faster, heuristics + light LLM)
poink ingest ~/docs --auto-tag

# Describe embedded PDF/DOCX visuals as searchable chunks
poink ingest ~/docs --visuals

# Process only first N files (for testing)
poink ingest ~/papers --enrich --sample 10

# Disable line progress output
poink ingest ~/papers --enrich --no-progress

# Limit a run to matching files
poink ingest ~/docs --include "**/*.md" --exclude "**/archive/**"
```

Bulk ingest can also read reusable file selection rules from config:

```bash
poink config set ingest.include "**/*.md,**/*.pdf"
poink config set ingest.exclude "**/archive/**,**/drafts/**"
```

When `--include` is passed, it replaces configured `ingest.include` for that
run. When `--exclude` is passed, it is added to configured `ingest.exclude`.

**Supported formats:**

- `.pdf` - Research papers, books, documents
- `.md` - Notes, documentation, Obsidian vaults, READMEs
- `.markdown` - Markdown documents
- `.txt` - Plain UTF-8 text documents
- `.docx` - Microsoft Word / OOXML documents
- `.odt` - OpenDocument text documents
- `.fodt` - Flat XML OpenDocument text documents

### Visual Enrichment

Visual enrichment is opt-in and currently supports embedded images in PDFs and
DOCX files. It extracts meaningful document visuals such as diagrams,
screenshots, charts, and figures, asks the configured `models.enrichment` model
to describe them, and stores those descriptions as normal searchable text
chunks. It does not store native image embeddings.

```bash
poink add document.pdf --visuals
poink add document.pdf --enrich --visuals
poink ingest ~/docs --visuals
poink rechunk --visuals --doc <id>
```

The enrichment model must be vision-capable. Visual enrichment adds vision-model
calls, so it can increase ingest/rechunk latency and provider cost.

## Enrichment

When you add documents with `--enrich`, the LLM extracts:

| Field                | Description                                 |
| -------------------- | ------------------------------------------- |
| **title**            | Clean, properly formatted title             |
| **author**           | Author name(s) if detectable                |
| **summary**          | 2-3 sentence summary                        |
| **documentType**     | book, paper, tutorial, guide, article, etc. |
| **category**         | Primary category                            |
| **tags**             | 5-10 descriptive tags                       |
| **concepts**         | Matched concepts from your taxonomy         |
| **proposedConcepts** | New concepts the LLM suggests adding        |

### LLM Providers

Enrichment supports multiple providers via the config system:

Provider API keys can be set either with `poink config set ...apiKey ...` or with the matching environment variable. Both approaches are supported; use whichever fits your workflow, but you only need to set one.

```bash
# Check current config
poink config show

# Use local Ollama (default)
poink config set models.enrichment.provider ollama
poink config set models.enrichment.model llama3.2:3b

# Use AI Gateway (Anthropic, OpenAI, etc.)
poink config set models.enrichment.provider gateway
poink config set models.enrichment.model anthropic/claude-haiku-4-5
poink config set providers.gateway.apiKey your-key
export AI_GATEWAY_API_KEY=your-key

# Use OpenAI directly
poink config set models.enrichment.provider openai
poink config set models.enrichment.model gpt-4o-mini
poink config set providers.openai.apiKey your-key
export OPENAI_API_KEY=your-key

# Use OpenAI Codex through your Codex/ChatGPT login
poink config set models.enrichment.provider openai-codex
poink config set models.enrichment.model gpt-5.5
poink config set models.judge.provider openai-codex
poink config set models.judge.model gpt-5.5
poink providers login --provider openai-codex --format text
# For headless devices, use Codex device authorization:
poink providers login --provider openai-codex --device-auth --format text

# Use OpenRouter
poink config set models.enrichment.provider openrouter
poink config set models.enrichment.model anthropic/claude-3.5-haiku
poink config set providers.openrouter.apiKey your-key
export OPENROUTER_API_KEY=your-key

# Use Google Generative AI
poink config set models.enrichment.provider google
poink config set models.enrichment.model gemini-2.5-flash
poink config set providers.google.apiKey your-key
export GOOGLE_GENERATIVE_AI_API_KEY=your-key

# Use Anthropic directly
poink config set models.enrichment.provider anthropic
poink config set models.enrichment.model claude-3-5-haiku-20241022
poink config set providers.anthropic.apiKey your-key
export ANTHROPIC_API_KEY=your-key

# Provider priority: CLI flag > config
poink add paper.pdf --enrich              # uses config
poink add paper.pdf --enrich --provider ollama  # override
```

### Enrichment Fallback

If LLM enrichment fails (API error, rate limit, malformed response), poink automatically falls back to heuristic-based enrichment:

- **Title**: Cleaned from filename
- **Tags**: Extracted from path, filename, and content keywords
- **Category**: Inferred from directory structure

The actual error is logged so you can debug provider issues.

## Taxonomy

The taxonomy is a hierarchical concept system for organizing documents. It ships with a starter taxonomy covering:

- **Programming** - TypeScript, React, Next.js, Testing, Architecture, DevOps, AI/ML
- **Education** - Instructional Design, Learning Science, Course Creation, Assessment
- **Business** - Marketing, Copywriting, Bootstrapping, Product, Sales
- **Design** - UX, Visual Design, Systems Thinking, Information Architecture
- **Meta** - Productivity, Note-taking, Knowledge Management, Writing

### Growing Your Taxonomy

When enriching documents, the LLM may propose new concepts. poink checks for similar existing concepts and auto-accepts novel proposals into the taxonomy.

```bash
# Manually add a concept
poink taxonomy add ai/rag --label "RAG" --broader programming/ai-ml
```

### Custom Taxonomy

Create your own `taxonomy.json`:

```json
{
  "concepts": [
    { "id": "cooking", "prefLabel": "Cooking" },
    { "id": "cooking/baking", "prefLabel": "Baking" },
    { "id": "cooking/grilling", "prefLabel": "Grilling" }
  ],
  "hierarchy": [
    { "conceptId": "cooking/baking", "broaderId": "cooking" },
    { "conceptId": "cooking/grilling", "broaderId": "cooking" }
  ]
}
```

Custom taxonomy JSON files can be loaded programmatically through the library API. The CLI currently seeds the bundled starter taxonomy during `poink setup init` and the non-interactive `poink init`.

## Configuration

### Config File

poink stores configuration in `~/.config/poink/config.json` unless `POINK_CONFIG` is set.

```bash
# Show all config
poink config show

# Get a specific value
poink config get models.enrichment.provider

# Set a value
poink config set models.enrichment.model anthropic/claude-haiku-4-5
```

### Config Options

```json
{
  "version": 1,
  "library": {
    "path": "~/.poink"
  },
  "chunking": {
    "strategy": "text",
    "size": 2000,
    "overlap": 200
  },
  "cli": {
    "globalFlags": {
      "format": "text"
    }
  },
  "ingest": {
    "include": [],
    "exclude": [],
    "visuals": {
      "enabled": false,
      "maxImageBytes": "5mb",
      "maxImagesPerDocument": 100
    },
    "urlDownloads": {
      "maxFileSize": "100mb",
      "timeout": "30s",
      "maxRedirects": 5,
      "allowPrivateNetwork": false,
      "allowedPrivateNetworkHosts": []
    }
  },
  "models": {
    "embedding": {
      "provider": "ollama",
      "model": "mxbai-embed-large"
    },
    "enrichment": {
      "provider": "gateway",
      "model": "anthropic/claude-haiku-4-5"
    },
    "judge": {
      "provider": "gateway",
      "model": "anthropic/claude-haiku-4-5"
    }
  },
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "autoPull": true
    },
    "gateway": {
      "apiKey": "...",
      "apiKeyEnv": "AI_GATEWAY_API_KEY"
    },
    "openai": {
      "apiKey": "...",
      "apiKeyEnv": "OPENAI_API_KEY",
      "baseUrl": "https://api.openai.com/v1"
    },
    "openrouter": {
      "apiKey": "...",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "baseUrl": "https://openrouter.ai/api/v1"
    },
    "google": {
      "apiKey": "...",
      "apiKeyEnv": "GOOGLE_GENERATIVE_AI_API_KEY",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta"
    },
    "anthropic": {
      "apiKey": "...",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "baseUrl": "https://api.anthropic.com/v1"
    }
  },
  "storage": {
    "libsql": {
      "url": "file:~/.poink/library.db"
    }
  },
  "server": {
    "host": "127.0.0.1",
    "port": 3838,
    "auth": {
      "enabled": false
    }
  }
}
```

| Setting                                          | Default                                            | Description                                                                               |
| ------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `library.path`                                   | `~/.poink`                                         | Library storage location                                                                  |
| `chunking.size`                                  | `2000`                                             | Chunk size in characters                                                                  |
| `chunking.overlap`                               | `200`                                              | Chunk overlap in characters                                                               |
| `cli.globalFlags.format`                         | `text`                                             | Default CLI output format: `text`, `json`, or `ndjson`                                    |
| `ingest.visuals.enabled`                         | `false`                                            | Enable PDF/DOCX visual enrichment by default                                              |
| `ingest.visuals.maxImageBytes`                   | `5mb`                                              | Maximum extracted image size sent for visual enrichment                                   |
| `ingest.visuals.maxImagesPerDocument`            | `100`                                              | Maximum extracted images described per document                                           |
| `ingest.urlDownloads.maxFileSize`                | `100mb`                                            | Maximum URL download size. Use a string with `b`, `kb`, `mb`, or `gb`                     |
| `ingest.urlDownloads.timeout`                    | `30s`                                              | URL download timeout. Use a string with `ms`, `s`, or `m`                                 |
| `ingest.urlDownloads.maxRedirects`               | `5`                                                | Maximum HTTP redirects followed during URL downloads                                      |
| `ingest.urlDownloads.allowPrivateNetwork`        | `false`                                            | Allow URL downloads from private, loopback, link-local, or reserved networks              |
| `ingest.urlDownloads.allowedPrivateNetworkHosts` | `[]`                                               | Hostname exceptions allowed to resolve to private-network addresses                       |
| `models.embedding.provider`                      | `ollama`                                           | Embedding provider                                                                        |
| `models.embedding.model`                         | `mxbai-embed-large`                                | Embedding model                                                                           |
| `models.enrichment.provider`                     | `ollama`                                           | LLM provider                                                                              |
| `models.enrichment.model`                        | `llama3.2:3b`                                      | Model for document enrichment                                                             |
| `models.enrichment.reasoning`                    | -                                                  | Optional reasoning level: `low`, `medium`, `high`, `none`, or `null` for provider default |
| `models.judge.provider`                          | `ollama`                                           | Provider for concept deduplication                                                        |
| `models.judge.model`                             | `llama3.2:3b`                                      | Model for judging duplicate concepts                                                      |
| `models.judge.reasoning`                         | -                                                  | Optional reasoning level: `low`, `medium`, `high`, `none`, or `null` for provider default |
| `providers.ollama.baseUrl`                       | `http://localhost:11434`                           | Ollama API endpoint                                                                       |
| `providers.ollama.autoPull`                      | `true`                                             | Auto-pull missing Ollama models when supported                                            |
| `providers.gateway.apiKey`                       | -                                                  | AI Gateway API key                                                                        |
| `providers.openai.apiKey`                        | -                                                  | OpenAI API key                                                                            |
| `providers.openai.baseUrl`                       | `https://api.openai.com/v1`                        | Optional OpenAI-compatible base URL                                                       |
| `providers.openrouter.apiKey`                    | -                                                  | OpenRouter API key                                                                        |
| `providers.openrouter.baseUrl`                   | `https://openrouter.ai/api/v1`                     | Optional OpenRouter API base URL                                                          |
| `providers.google.apiKey`                        | -                                                  | Google Generative AI API key                                                              |
| `providers.google.baseUrl`                       | `https://generativelanguage.googleapis.com/v1beta` | Optional Google Generative AI base URL                                                    |
| `providers.anthropic.apiKey`                     | -                                                  | Anthropic API key                                                                         |
| `providers.anthropic.baseUrl`                    | `https://api.anthropic.com/v1`                     | Optional Anthropic API base URL                                                           |
| `storage.libsql.url`                             | `file:~/.poink/library.db`                         | Local file or remote libSQL database URL                                                  |
| `storage.libsql.authToken`                       | -                                                  | Direct authentication token for remote libSQL                                             |
| `storage.libsql.authTokenEnv`                    | -                                                  | Environment variable containing the remote libSQL token                                   |
| `server.host`                                    | `127.0.0.1`                                        | Host/interface for `poink serve`                                                          |
| `server.port`                                    | `3838`                                             | HTTP port for `poink serve`                                                               |
| `server.auth.enabled`                            | `false`                                            | Require bearer auth on `/mcp`                                                             |
| `server.auth.token`                              | -                                                  | Bearer token for `/mcp`                                                                   |
| `server.auth.tokenEnv`                           | `POINK_SERVER_TOKEN`                               | Environment variable for bearer token                                                     |

Embedding dimensions are not user configuration. poink derives the vector
dimension from embeddings returned by the configured provider and records it in
database metadata, then rejects later embeddings with a different dimension.

For a remote database, configure both its URL and token source:

```json
{
  "storage": {
    "libsql": {
      "url": "libsql://your-database.turso.io",
      "authTokenEnv": "TURSO_AUTH_TOKEN"
    }
  }
}
```

For language models that support configurable reasoning or thinking, set
`models.enrichment.reasoning` or `models.judge.reasoning` to `low`, `medium`, or
`high`. Set it to `none` to request an instant/non-reasoning mode when the
provider supports one. Leave it unset or set it to `null` to use the provider's
default. poink passes configured reasoning through to the selected provider;
unsupported combinations are left for the provider to accept, ignore, or reject.

### Environment Variables

| Variable                       | Default                        | Description                                 |
| ------------------------------ | ------------------------------ | ------------------------------------------- |
| `POINK_CONFIG`                 | `~/.config/poink/config.json`  | Config file path                            |
| `AI_GATEWAY_API_KEY`           | -                              | API key for AI Gateway                      |
| `OPENAI_API_KEY`               | -                              | API key for OpenAI                          |
| `OPENROUTER_API_KEY`           | -                              | API key for OpenRouter                      |
| `OPENROUTER_BASE_URL`          | `https://openrouter.ai/api/v1` | Optional OpenRouter base URL                |
| `GOOGLE_GENERATIVE_AI_API_KEY` | -                              | API key for Google Generative AI            |
| `ANTHROPIC_API_KEY`            | -                              | API key for Anthropic                       |
| `POINK_LOG_LEVEL`              | `silent`                       | stderr logging verbosity                    |
| `POINK_QUERY_EMBED_CACHE_SIZE` | `256`                          | Query embedding LRU cache size (0 disables) |

### AI Gateway

For cloud LLM providers (Anthropic, OpenAI, etc.), use the AI Gateway:

```bash
# Set your API key in poink config or via environment
poink config set providers.gateway.apiKey your-key
export AI_GATEWAY_API_KEY=your-key

# Configure to use gateway
poink config set models.enrichment.provider gateway
poink config set models.enrichment.model anthropic/claude-haiku-4-5

# Other supported models:
# - anthropic/claude-sonnet-4-20250514
# - openai/gpt-4o-mini
# - openai/gpt-4o
```

### OpenRouter

For OpenRouter, switch the provider and use an OpenRouter model ID. `poink` uses the official `@openrouter/ai-sdk-provider` integration for AI SDK v6.

```bash
poink config set providers.openrouter.apiKey your-key
export OPENROUTER_API_KEY=your-key

poink config set models.enrichment.provider openrouter
poink config set models.enrichment.model anthropic/claude-3.5-haiku
```

OpenRouter embeddings also work through the same provider abstraction:

```bash
poink config set models.embedding.provider openrouter
poink config set models.embedding.model openai/text-embedding-3-small
```

OpenAI embeddings can be configured directly:

```bash
poink config set providers.openai.apiKey your-key
export OPENAI_API_KEY=your-key

poink config set models.embedding.provider openai
poink config set models.embedding.model text-embedding-3-small
```

### OpenAI Codex

OpenAI Codex can be configured for enrichment and judge language-model calls. It uses the managed Codex runtime installed with poink and authenticates through Codex, not through an OpenAI API key. It is not an embedding provider.

```bash
poink config set models.enrichment.provider openai-codex
poink config set models.enrichment.model gpt-5.5

poink config set models.judge.provider openai-codex
poink config set models.judge.model gpt-5.5

poink providers login --provider openai-codex --format text
# For headless devices, use Codex device authorization:
poink providers login --provider openai-codex --device-auth --format text
poink doctor
```

Google language and embedding models can be configured directly:

```bash
poink config set providers.google.apiKey your-key
export GOOGLE_GENERATIVE_AI_API_KEY=your-key

poink config set models.enrichment.provider google
poink config set models.enrichment.model gemini-2.5-flash

poink config set models.embedding.provider google
poink config set models.embedding.model gemini-embedding-001
```

Anthropic can be configured directly for enrichment and judge models. Anthropic does not provide embeddings, so keep `models.embedding.provider` on `ollama`, `openai`, `openrouter`, `gateway`, or `google`.

```bash
poink config set providers.anthropic.apiKey your-key
export ANTHROPIC_API_KEY=your-key

poink config set models.enrichment.provider anthropic
poink config set models.enrichment.model claude-3-5-haiku-20241022
```

## Storage

```
~/.poink/
+-- library.db          # libSQL database (vectors, FTS, metadata, taxonomy)
+-- library.db-shm      # Shared memory (WAL mode)
+-- library.db-wal      # Write-ahead log
+-- downloads/          # Documents downloaded from URLs
```

### Database Size

With the default libSQL backend, the database can get **large** due to vector index overhead. For ~500k chunks:

| Component    | Size   | Notes                             |
| ------------ | ------ | --------------------------------- |
| Text content | ~180MB | Actual chunk text                 |
| Embeddings   | ~1.9GB | 500k x 1024 dims x 4 bytes        |
| Vector index | ~48GB  | HNSW neighbor graphs (~100KB/row) |
| FTS index    | ~200MB | Full-text search                  |

The `*_idx_shadow` tables store HNSW neighbor graphs for approximate nearest neighbor search. Each row averages ~100KB.

**libSQL quirk**: `SELECT COUNT(*) FROM embeddings` returns 0. Always count a specific column:

```sql
SELECT COUNT(chunk_id) FROM embeddings  -- correct
```

## How It Works

1. **Extract** - PDF text via `pdf-parse`, Markdown and plain TXT parsed directly, DOCX via `mammoth`, ODT/FODT via OpenDocument XML
2. **Enrich** (optional) - LLM extracts metadata, matches taxonomy concepts
3. **Chunk** - Text split into ~512 token chunks with overlap
4. **Embed** - Each chunk embedded via the configured embedding provider
5. **Store** - Documents, embeddings, taxonomy, and mappings in one libSQL database
6. **Search** - Query embedded, compared via cosine similarity

## MCP Integration

poink ships as an MCP server for AI coding assistants:

MCP tool responses remain JSON-friendly regardless of the CLI default format:
tools return a JSON envelope in `structuredContent` and in their text content.

```json
{
  "mcpServers": {
    "poink": {
      "command": "npx",
      "args": ["-y", "poink-cli", "mcp"]
    }
  }
}
```

### Document Tools

| Tool          | Description                                   |
| ------------- | --------------------------------------------- |
| `search`      | Unified semantic search (docs + concepts)     |
| `search_pack` | Run multiple searches and aggregate results   |
| `list`        | List documents, optionally filter by tag      |
| `read`        | Get document details and metadata             |
| `chunk_get`   | Fetch one chunk by chunk ID                   |
| `doc_chunks`  | List chunk IDs for a document                 |
| `page_get`    | Reconstruct page text from chunks             |
| `stats`       | Library statistics (docs, chunks, embeddings) |

### Taxonomy Tools

| Tool              | Description                                      |
| ----------------- | ------------------------------------------------ |
| `taxonomy_list`   | List taxonomy concept summaries                  |
| `taxonomy_tree`   | Render the full taxonomy tree or a subtree       |
| `taxonomy_get`    | Get concept details and relationships            |
| `taxonomy_search` | Search concepts by label or embedding similarity |

### Discovery Tools

| Tool            | Description                            |
| --------------- | -------------------------------------- |
| `capabilities`  | Describe commands, flags, and formats  |
| `config_schema` | Retrieve the configuration JSON Schema |

### Utility Tools

| Tool      | Description                          |
| --------- | ------------------------------------ |
| `doctor`  | Run health checks and optional fixes |
| `rechunk` | Rebuild chunks and embeddings        |

## Troubleshooting

### "Ollama not available"

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Start Ollama
ollama serve

# Check models
ollama list
```

### "Model not found"

```bash
# Pull default local models
ollama pull mxbai-embed-large
ollama pull llama3.2:3b
```

### "Database locked"

The database uses WAL mode. If you see lock errors:

```bash
# Check for zombie processes
lsof ~/.poink/library.db*

# Force checkpoint
sqlite3 ~/.poink/library.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

### Slow enrichment

Enrichment is CPU-intensive. For large batches:

- Use `--auto-tag` instead of `--enrich` for faster processing
- Run overnight for large libraries
- Consider GPU acceleration for Ollama

## Development

```bash
# Clone
git clone <repository-url>
cd poink

# Install
npm install

# Run CLI
npm run dev -- <command>

# Run tests
npm test

# Type check
npm run typecheck
```

## License

MIT
