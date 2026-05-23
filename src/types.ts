/**
 * Document Library Types
 */

import { Schema } from "effect";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join, win32 } from "path";
import {
  DEFAULT_CLI_OUTPUT_FORMAT,
  DEFAULT_SERVER_AUTH_TOKEN_ENV,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "./agent/protocol.js";
import { assertValidChunking } from "./chunking.js";

// ============================================================================
// Domain Models
// ============================================================================

/**
 * Represents a document in the library.
 */
export type DocumentFileType = "pdf" | "markdown" | "docx" | "odt";

export class Document extends Schema.Class<Document>("Document")({
  id: Schema.String,
  title: Schema.String,
  path: Schema.String,
  addedAt: Schema.Date,
  pageCount: Schema.Number,
  sizeBytes: Schema.Number,
  tags: Schema.Array(Schema.String),
  fileType: Schema.optionalWith(
    Schema.Literal("pdf", "markdown", "docx", "odt"),
    {
    default: () => "pdf" as const,
    },
  ),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
}) {}

/**
 * @deprecated Use Document instead. Kept for backwards compatibility.
 */
export type PDFDocument = Document;
export const PDFDocument = Document;

export class PDFChunk extends Schema.Class<PDFChunk>("PDFChunk")({
  id: Schema.String,
  docId: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
  embeddingContent: Schema.optional(Schema.String),
}) {}

/**
 * Entity type discriminator for unified search results
 */
export type EntityType = "document" | "concept";

/**
 * @deprecated Use DocumentSearchResult for unified search. Kept for backwards compatibility.
 */
export class SearchResult extends Schema.Class<SearchResult>("SearchResult")({
  chunkId: Schema.String,
  docId: Schema.String,
  title: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
  /** Normalized score in 0..1 for ranking across match types */
  score: Schema.Number,
  /** Raw score from the underlying engine (e.g. cosine similarity, FTS rank) */
  rawScore: Schema.Number,
  /** What rawScore represents (do not assume one score meaning across engines) */
  scoreType: Schema.Literal("cosine_similarity", "fts_rank", "hybrid"),
  /** Optional component score for vector results */
  vectorScore: Schema.optional(Schema.Number),
  /** Optional component score for FTS results (raw FTS rank; often negative, more negative = better) */
  ftsRank: Schema.optional(Schema.Number),
  matchType: Schema.Literal("vector", "fts", "hybrid"),
  /** Expanded context around the match (only populated when expandChars > 0) */
  expandedContent: Schema.optional(Schema.String),
  /** Range of chunk indices included in expandedContent */
  expandedRange: Schema.optional(
    Schema.Struct({ start: Schema.Number, end: Schema.Number })
  ),
}) {
  /**
   * Backwards-compatible constructor:
   * Older callers used `SearchResult` without chunkId/rawScore/scoreType.
   *
   * This type is deprecated in favor of `DocumentSearchResult`, but we keep
   * legacy input working so downstream code doesn't explode.
   */
  constructor(props: any) {
    const docId = props?.docId;
    const page = props?.page;
    const chunkIndex = props?.chunkIndex;

    const matchType: "vector" | "fts" | "hybrid" = props?.matchType;
    const score: number = props?.score;

    const chunkId =
      props?.chunkId ?? `legacy:${String(docId)}:${String(page)}:${String(chunkIndex)}`;

    const rawScore = props?.rawScore ?? score;

    const scoreType =
      props?.scoreType ??
      (matchType === "fts"
        ? "fts_rank"
        : matchType === "hybrid"
          ? "hybrid"
          : "cosine_similarity");

    const vectorScore =
      props?.vectorScore ?? (matchType === "vector" ? score : undefined);

    super({
      ...props,
      chunkId,
      rawScore,
      scoreType,
      vectorScore,
    });
  }
}

/**
 * Document search result with entity type discriminator
 */
export class DocumentSearchResult extends Schema.Class<DocumentSearchResult>(
  "DocumentSearchResult"
)({
  chunkId: Schema.String,
  docId: Schema.String,
  title: Schema.String,
  page: Schema.Number,
  chunkIndex: Schema.Number,
  content: Schema.String,
  /** Normalized score in 0..1 for ranking across match types */
  score: Schema.Number,
  /** Raw score from the underlying engine (e.g. cosine similarity, FTS rank) */
  rawScore: Schema.Number,
  /** What rawScore represents (do not assume one score meaning across engines) */
  scoreType: Schema.Literal("cosine_similarity", "fts_rank", "hybrid"),
  /** Optional component score for vector results */
  vectorScore: Schema.optional(Schema.Number),
  /** Optional component score for FTS results (raw FTS rank; often negative, more negative = better) */
  ftsRank: Schema.optional(Schema.Number),
  matchType: Schema.Literal("vector", "fts", "hybrid"),
  entityType: Schema.Literal("document"),
  /** Expanded context around the match (only populated when expandChars > 0) */
  expandedContent: Schema.optional(Schema.String),
  /** Range of chunk indices included in expandedContent */
  expandedRange: Schema.optional(
    Schema.Struct({ start: Schema.Number, end: Schema.Number })
  ),
}) {}

/**
 * Concept search result from taxonomy/SKOS
 */
export class ConceptSearchResult extends Schema.Class<ConceptSearchResult>(
  "ConceptSearchResult"
)({
  conceptId: Schema.String,
  prefLabel: Schema.String,
  definition: Schema.String,
  /** Normalized score in 0..1 */
  score: Schema.Number,
  /** Raw score from the underlying engine (cosine similarity) */
  rawScore: Schema.Number,
  scoreType: Schema.Literal("cosine_similarity"),
  entityType: Schema.Literal("concept"),
}) {}

/**
 * Unified search result - can be either document or concept
 */
export type UnifiedSearchResult = DocumentSearchResult | ConceptSearchResult;

// ============================================================================
// Configuration
// ============================================================================

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir() || ".";
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function joinForBase(basePath: string, ...segments: string[]): string {
  return isWindowsPath(basePath)
    ? win32.join(basePath, ...segments)
    : join(basePath, ...segments);
}

export function getDefaultLibraryPath(): string {
  return joinForBase(resolveHomeDir(), ".poink");
}

export function expandHomePath(path: string): string {
  if (path === "~") return resolveHomeDir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return joinForBase(resolveHomeDir(), path.slice(2));
  }
  return path;
}

const DEFAULT_CHUNK_SIZE = 2000;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_LIBRARY_PATH = "~/.poink";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_LIBSQL_URL = "file:~/.poink/library.db";

function getLibraryConfigProps(libraryPath: string) {
  assertValidChunking(DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP);

  return {
    libraryPath,
    dbPath: joinForBase(libraryPath, "library.db"),
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
  };
}

export class LibraryConfig extends Schema.Class<LibraryConfig>("LibraryConfig")(
  {
    libraryPath: Schema.String,
    dbPath: Schema.String,
    chunkSize: Schema.Number,
    chunkOverlap: Schema.Number,
  }
) {
  static readonly Default = new LibraryConfig(
    getLibraryConfigProps(getDefaultLibraryPath()),
  );

  static fromEnv(): LibraryConfig {
    const config = loadConfig();
    const libraryPath = resolveLibraryPath(config);
    const props = getLibraryConfigProps(libraryPath);
    const chunking = resolveChunkingConfig(config);
    return new LibraryConfig({
      ...props,
      chunkSize: chunking.chunkSize,
      chunkOverlap: chunking.chunkOverlap,
    });
  }
}

export type ModelRole = "embedding" | "enrichment" | "judge";
export type ProviderName =
  | "ollama"
  | "gateway"
  | "openai"
  | "openai-codex"
  | "openrouter"
  | "google"
  | "anthropic";

export type EmbeddingProviderName = Exclude<
  ProviderName,
  "anthropic" | "openai-codex"
>;
export type ReasoningLevel = "low" | "medium" | "high" | "none";
export type CLIOutputFormat = OutputFormat;

const EmbeddingProviderNameSchema = Schema.Literal(
  "ollama",
  "gateway",
  "openai",
  "openrouter",
  "google",
);

const LanguageProviderNameSchema = Schema.Literal(
  "ollama",
  "gateway",
  "openai",
  "openai-codex",
  "openrouter",
  "google",
  "anthropic",
);

const ReasoningLevelSchema = Schema.Literal("low", "medium", "high", "none");
const CLIOutputFormatSchema = Schema.Literal(...OUTPUT_FORMATS);

const EmbeddingModelRefSchema = Schema.Struct({
  provider: EmbeddingProviderNameSchema,
  model: Schema.String,
});

const LanguageModelRefSchema = Schema.Struct({
  provider: LanguageProviderNameSchema,
  model: Schema.String,
  reasoning: Schema.optional(Schema.NullOr(ReasoningLevelSchema)),
});

const SecretRefSchema = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  apiKeyEnv: Schema.optional(Schema.String),
});

/**
 * Multi-provider configuration for embedding, enrichment, and judge models.
 */
export class Config extends Schema.Class<Config>("Config")({
  version: Schema.optionalWith(Schema.Number, { default: () => 1 }),
  library: Schema.optionalWith(Schema.Struct({
    path: Schema.optionalWith(Schema.String, {
      default: () => DEFAULT_LIBRARY_PATH,
    }),
  }), {
    default: () => ({ path: DEFAULT_LIBRARY_PATH }),
  }),
  chunking: Schema.optionalWith(Schema.Struct({
    strategy: Schema.optionalWith(Schema.Literal("text"), {
      default: () => "text" as const,
    }),
    size: Schema.optionalWith(Schema.Number, {
      default: () => DEFAULT_CHUNK_SIZE,
    }),
    overlap: Schema.optionalWith(Schema.Number, {
      default: () => DEFAULT_CHUNK_OVERLAP,
    }),
  }), {
    default: () => ({
      strategy: "text" as const,
      size: DEFAULT_CHUNK_SIZE,
      overlap: DEFAULT_CHUNK_OVERLAP,
    }),
  }),
  cli: Schema.optionalWith(Schema.Struct({
    globalFlags: Schema.optionalWith(Schema.Struct({
      format: Schema.optionalWith(CLIOutputFormatSchema, {
        default: () => DEFAULT_CLI_OUTPUT_FORMAT,
      }),
    }), {
      default: () => ({ format: DEFAULT_CLI_OUTPUT_FORMAT }),
    }),
  }), {
    default: () => ({
      globalFlags: {
        format: DEFAULT_CLI_OUTPUT_FORMAT,
      },
    }),
  }),
  models: Schema.Struct({
    embedding: EmbeddingModelRefSchema,
    enrichment: LanguageModelRefSchema,
    judge: LanguageModelRefSchema,
  }),
  providers: Schema.optionalWith(Schema.Struct({
    ollama: Schema.optionalWith(Schema.Struct({
      baseUrl: Schema.optionalWith(Schema.String, {
        default: () => DEFAULT_OLLAMA_BASE_URL,
      }),
      autoPull: Schema.optionalWith(Schema.Boolean, {
        default: () => true,
      }),
    }), {
      default: () => ({
        baseUrl: DEFAULT_OLLAMA_BASE_URL,
        autoPull: true,
      }),
    }),
    gateway: Schema.optionalWith(SecretRefSchema, {
      default: () => ({ apiKeyEnv: "AI_GATEWAY_API_KEY" }),
    }),
    openai: Schema.optionalWith(Schema.Struct({
      apiKey: Schema.optional(Schema.String),
      apiKeyEnv: Schema.optionalWith(Schema.String, {
        default: () => "OPENAI_API_KEY",
      }),
      baseUrl: Schema.optionalWith(Schema.String, {
        default: () => DEFAULT_OPENAI_BASE_URL,
      }),
    }), {
      default: () => ({
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: DEFAULT_OPENAI_BASE_URL,
      }),
    }),
    "openai-codex": Schema.optionalWith(Schema.Struct({}).pipe(
      Schema.filter((value) => Object.keys(value).length === 0, {
        message: () =>
          "OpenAI Codex provider does not accept configuration in this release.",
      }),
    ), {
      default: () => ({}),
    }),
    openrouter: Schema.optionalWith(Schema.Struct({
      apiKey: Schema.optional(Schema.String),
      apiKeyEnv: Schema.optionalWith(Schema.String, {
        default: () => "OPENROUTER_API_KEY",
      }),
      baseUrl: Schema.optionalWith(Schema.String, {
        default: () => DEFAULT_OPENROUTER_BASE_URL,
      }),
    }), {
      default: () => ({
        apiKeyEnv: "OPENROUTER_API_KEY",
        baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      }),
    }),
    google: Schema.optionalWith(Schema.Struct({
      apiKey: Schema.optional(Schema.String),
      apiKeyEnv: Schema.optionalWith(Schema.String, {
        default: () => "GOOGLE_GENERATIVE_AI_API_KEY",
      }),
      baseUrl: Schema.optionalWith(Schema.String, {
        default: () => DEFAULT_GOOGLE_BASE_URL,
      }),
    }), {
      default: () => ({
        apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
        baseUrl: DEFAULT_GOOGLE_BASE_URL,
      }),
    }),
    anthropic: Schema.optionalWith(Schema.Struct({
      apiKey: Schema.optional(Schema.String),
      apiKeyEnv: Schema.optionalWith(Schema.String, {
        default: () => "ANTHROPIC_API_KEY",
      }),
      baseUrl: Schema.optionalWith(Schema.String, {
        default: () => DEFAULT_ANTHROPIC_BASE_URL,
      }),
    }), {
      default: () => ({
        apiKeyEnv: "ANTHROPIC_API_KEY",
        baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
      }),
    }),
  }), {
    default: () => ({
      ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL, autoPull: true },
      gateway: { apiKeyEnv: "AI_GATEWAY_API_KEY" },
      openai: {
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: DEFAULT_OPENAI_BASE_URL,
      },
      "openai-codex": {},
      openrouter: {
        apiKeyEnv: "OPENROUTER_API_KEY",
        baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      },
      google: {
        apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
        baseUrl: DEFAULT_GOOGLE_BASE_URL,
      },
      anthropic: {
        apiKeyEnv: "ANTHROPIC_API_KEY",
        baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
      },
    }),
  }),
  storage: Schema.optionalWith(
    Schema.Struct({
      backend: Schema.optionalWith(Schema.Literal("libsql", "qdrant"), {
        default: () => "libsql" as const,
      }),
      libsql: Schema.optionalWith(
        Schema.Struct({
          url: Schema.optionalWith(Schema.String, {
            default: () => DEFAULT_LIBSQL_URL,
          }),
          authToken: Schema.optional(Schema.String),
          authTokenEnv: Schema.optional(Schema.String),
        }),
        {
          default: () => ({
            url: DEFAULT_LIBSQL_URL,
          }),
        },
      ),
      qdrant: Schema.optionalWith(
        Schema.Struct({
          url: Schema.String,
          collection: Schema.String,
          apiKey: Schema.optional(Schema.String),
          apiKeyEnv: Schema.optionalWith(Schema.String, {
            default: () => "QDRANT_API_KEY",
          }),
        }),
        {
          default: () => ({
            url: "http://localhost:6333",
            collection: "poink",
            apiKeyEnv: "QDRANT_API_KEY",
          }),
        }
      ),
    }),
    {
      default: () => ({
        backend: "libsql" as const,
        libsql: {
          url: "file:~/.poink/library.db",
        },
        qdrant: {
          url: "http://localhost:6333",
          collection: "poink",
          apiKeyEnv: "QDRANT_API_KEY",
        },
      }),
    }
  ),
  server: Schema.optionalWith(
    Schema.Struct({
      host: Schema.optionalWith(Schema.String, {
        default: () => "127.0.0.1",
      }),
      port: Schema.optionalWith(Schema.Number, {
        default: () => 3838,
      }),
      auth: Schema.optionalWith(
        Schema.Struct({
          enabled: Schema.optionalWith(Schema.Boolean, {
            default: () => false,
          }),
          token: Schema.optional(Schema.String),
          tokenEnv: Schema.optionalWith(Schema.String, {
            default: () => DEFAULT_SERVER_AUTH_TOKEN_ENV,
          }),
        }),
        {
          default: () => ({
            enabled: false,
            tokenEnv: DEFAULT_SERVER_AUTH_TOKEN_ENV,
          }),
        }
      ),
    }),
    {
      default: () => ({
        host: "127.0.0.1",
        port: 3838,
        auth: {
          enabled: false,
          tokenEnv: DEFAULT_SERVER_AUTH_TOKEN_ENV,
        },
      }),
    }
  ),
}) {
  /**
   * Default configuration: Ollama for all providers
   */
  static readonly Default = new Config({
    version: 1,
    library: {
      path: DEFAULT_LIBRARY_PATH,
    },
    chunking: {
      strategy: "text",
      size: DEFAULT_CHUNK_SIZE,
      overlap: DEFAULT_CHUNK_OVERLAP,
    },
    cli: {
      globalFlags: {
        format: DEFAULT_CLI_OUTPUT_FORMAT,
      },
    },
    models: {
      embedding: {
        provider: "ollama" as const,
        model: "mxbai-embed-large",
      },
      enrichment: {
        provider: "ollama" as const,
        model: "llama3.2:3b",
      },
      judge: {
        provider: "ollama" as const,
        model: "llama3.2:3b",
      },
    },
    providers: {
      ollama: {
        baseUrl: DEFAULT_OLLAMA_BASE_URL,
        autoPull: true,
      },
      gateway: {
        apiKeyEnv: "AI_GATEWAY_API_KEY",
      },
      openai: {
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: DEFAULT_OPENAI_BASE_URL,
      },
      "openai-codex": {},
      openrouter: {
        apiKeyEnv: "OPENROUTER_API_KEY",
        baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      },
      google: {
        apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
        baseUrl: DEFAULT_GOOGLE_BASE_URL,
      },
      anthropic: {
        apiKeyEnv: "ANTHROPIC_API_KEY",
        baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
      },
    },
    storage: {
      backend: "libsql",
      libsql: {
        url: DEFAULT_LIBSQL_URL,
      },
      qdrant: {
        url: "http://localhost:6333",
        collection: "poink",
        apiKeyEnv: "QDRANT_API_KEY",
      },
    },
    server: {
      host: "127.0.0.1",
      port: 3838,
      auth: {
        enabled: false,
        tokenEnv: DEFAULT_SERVER_AUTH_TOKEN_ENV,
      },
    },
  });

  /**
   * Resolve the gateway API key: config takes precedence over env var.
   */
  get gatewayApiKey(): string | undefined {
    return this.providers.gateway.apiKey ??
      readConfiguredEnv(this.providers.gateway.apiKeyEnv) ??
      process.env.AI_GATEWAY_API_KEY;
  }

  /**
   * Resolve the OpenAI API key: config takes precedence over env var.
   */
  get openaiApiKey(): string | undefined {
    return this.providers.openai.apiKey ??
      readConfiguredEnv(this.providers.openai.apiKeyEnv) ??
      process.env.OPENAI_API_KEY;
  }

  get openaiBaseUrl(): string | undefined {
    return this.providers.openai.baseUrl;
  }

  /**
   * Resolve the OpenRouter API key: config takes precedence over env var.
   */
  get openrouterApiKey(): string | undefined {
    return this.providers.openrouter.apiKey ??
      readConfiguredEnv(this.providers.openrouter.apiKeyEnv) ??
      process.env.OPENROUTER_API_KEY;
  }

  get openrouterBaseUrl(): string | undefined {
    const configured = this.providers.openrouter.baseUrl;
    if (configured && !isDefaultOpenRouterBaseUrl(configured)) {
      return configured;
    }
    return process.env.OPENROUTER_BASE_URL ?? configured;
  }

  /**
   * Resolve the Google Generative AI API key: config takes precedence over env var.
   */
  get googleApiKey(): string | undefined {
    return this.providers.google.apiKey ??
      readConfiguredEnv(this.providers.google.apiKeyEnv) ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  }

  /**
   * Resolve the Anthropic API key: config takes precedence over env var.
   */
  get anthropicApiKey(): string | undefined {
    return this.providers.anthropic.apiKey ??
      readConfiguredEnv(this.providers.anthropic.apiKeyEnv) ??
      process.env.ANTHROPIC_API_KEY;
  }
}

function isDefaultOpenRouterBaseUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, "") === DEFAULT_OPENROUTER_BASE_URL;
}

function readConfiguredEnv(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return process.env[name];
}

export function getModelConfig(config: Config, role: ModelRole) {
  return config.models[role];
}

export function resolveLibraryPath(config: Config): string {
  return expandHomePath(config.library.path);
}

export function resolveLibraryDbPath(config: Config): string {
  return joinForBase(resolveLibraryPath(config), "library.db");
}

export function resolveLibsqlUrl(config: Config): string {
  const configured = config.storage.libsql.url;
  if (!configured || configured === DEFAULT_LIBSQL_URL) {
    return `file:${resolveLibraryDbPath(config)}`;
  }
  if (configured.startsWith("file:~/") || configured.startsWith("file:~\\")) {
    return `file:${expandHomePath(configured.slice("file:".length))}`;
  }
  return configured;
}

export function resolveChunkingConfig(config: Config) {
  assertValidChunking(config.chunking.size, config.chunking.overlap);
  return {
    chunkSize: config.chunking.size,
    chunkOverlap: config.chunking.overlap,
  };
}

export function resolveStorageApiKey(value: {
  apiKey?: string;
  apiKeyEnv?: string;
}): string | undefined {
  return value.apiKey ?? readConfiguredEnv(value.apiKeyEnv);
}

// ============================================================================
// Config Helpers
// ============================================================================

/**
 * Preferred config path (~/.config/poink/config.json unless overridden).
 */
export function getDefaultConfigPath(): string {
  return join(resolveHomeDir(), ".config", "poink", "config.json");
}

/**
 * Resolve the active config path.
 * Priority:
 * 1) $POINK_CONFIG
 * 2) ~/.config/poink/config.json
 */
export function resolveConfigPath(): string {
  return process.env.POINK_CONFIG || getDefaultConfigPath();
}

/**
 * Decode config data and apply schema defaults for missing fields.
 */
export function normalizeConfig(configData: unknown): Config {
  const config = Schema.decodeUnknownSync(Config)(configData);
  resolveChunkingConfig(config);
  return config;
}

/**
 * Load config from resolved path.
 * Creates config.json with defaults if it doesn't exist.
 */
export function loadConfig(): Config {
  const configPath = resolveConfigPath();

  // Create config file with defaults if missing.
  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(Config.Default, null, 2), "utf-8");
    return Config.Default;
  }

  // Read and parse existing config
  const configJson = readFileSync(configPath, "utf-8");
  const configData = JSON.parse(configJson);

  // Validate and return via Schema
  return normalizeConfig(configData);
}

/**
 * Save config to resolved path.
 * API keys can be stored in config or read from env var AI_GATEWAY_API_KEY.
 */
export function saveConfig(config: Config): void {
  const configPath = resolveConfigPath();

  // Ensure directory exists
  mkdirSync(dirname(configPath), { recursive: true });

  // Write config (Schema.encode not needed for simple JSON serialization)
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// ============================================================================
// Options
// ============================================================================

export class SearchOptions extends Schema.Class<SearchOptions>("SearchOptions")(
  {
    limit: Schema.optionalWith(Schema.Number, { default: () => 10 }),
    threshold: Schema.optionalWith(Schema.Number, { default: () => 0.0 }),
    tags: Schema.optional(Schema.Array(Schema.String)),
    hybrid: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    /** Max chars for expanded context per result. 0 = no expansion (default) */
    expandChars: Schema.optionalWith(Schema.Number, { default: () => 0 }),
    /** Filter by entity types. Default: both documents and concepts */
    entityTypes: Schema.optional(
      Schema.Array(Schema.Literal("document", "concept"))
    ),
    /** Include cluster summaries in search results (RAPTOR-style multi-scale retrieval). Default: false */
    includeClusterSummaries: Schema.optionalWith(Schema.Boolean, {
      default: () => false,
    }),
  }
) {}

export class AddOptions extends Schema.Class<AddOptions>("AddOptions")({
  title: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
  /**
   * Internal/advanced: preserve original `addedAt` on re-add/rechunk workflows.
   * CLI does not expose this directly.
   */
  addedAt: Schema.optional(Schema.Date),
}) {}

// ============================================================================
// Errors
// ============================================================================

export class PDFNotFoundError extends Schema.TaggedError<PDFNotFoundError>()(
  "PDFNotFoundError",
  { path: Schema.String }
) {}

export class PDFExtractionError extends Schema.TaggedError<PDFExtractionError>()(
  "PDFExtractionError",
  { path: Schema.String, reason: Schema.String }
) {}

export class MarkdownNotFoundError extends Schema.TaggedError<MarkdownNotFoundError>()(
  "MarkdownNotFoundError",
  { path: Schema.String }
) {}

export class MarkdownExtractionError extends Schema.TaggedError<MarkdownExtractionError>()(
  "MarkdownExtractionError",
  { path: Schema.String, reason: Schema.String }
) {}

export class OllamaError extends Schema.TaggedError<OllamaError>()(
  "OllamaError",
  { reason: Schema.String }
) {}

export class GatewayError extends Schema.TaggedError<GatewayError>()(
  "GatewayError",
  { reason: Schema.String }
) {}

export class OpenAIError extends Schema.TaggedError<OpenAIError>()(
  "OpenAIError",
  { reason: Schema.String }
) {}

export class OpenAICodexError extends Schema.TaggedError<OpenAICodexError>()(
  "OpenAICodexError",
  { reason: Schema.String }
) {}

export class OpenRouterError extends Schema.TaggedError<OpenRouterError>()(
  "OpenRouterError",
  { reason: Schema.String }
) {}

export class GoogleError extends Schema.TaggedError<GoogleError>()(
  "GoogleError",
  { reason: Schema.String }
) {}

export class AnthropicError extends Schema.TaggedError<AnthropicError>()(
  "AnthropicError",
  { reason: Schema.String }
) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  { reason: Schema.String }
) {}

export class DocumentNotFoundError extends Schema.TaggedError<DocumentNotFoundError>()(
  "DocumentNotFoundError",
  { query: Schema.String }
) {}

export class DocumentExistsError extends Schema.TaggedError<DocumentExistsError>()(
  "DocumentExistsError",
  { title: Schema.String, path: Schema.String }
) {}

export class URLFetchError extends Schema.TaggedError<URLFetchError>()(
  "URLFetchError",
  { url: Schema.String, reason: Schema.String }
) {}
