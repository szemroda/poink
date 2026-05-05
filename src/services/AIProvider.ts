import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider-v2";
import {
  GatewayError,
  type Config,
  OllamaError,
  OpenAIError,
} from "../types.js";

export type SupportedProvider = "ollama" | "openai" | "gateway";
export type ProviderError = GatewayError | OllamaError | OpenAIError;
export type ConfiguredLanguageRole = "enrichment" | "judge" | "summary";

export interface ResolvedEmbeddingModel {
  readonly provider: SupportedProvider;
  readonly modelId: string;
  readonly model: any;
}

export interface ResolvedLanguageModel {
  readonly provider: SupportedProvider;
  readonly modelId: string;
  readonly model: any;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export function normalizeOllamaBaseUrl(
  baseUrl: string | undefined,
): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return undefined;
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
}

export function describeLanguageModelError(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    const request = error as Error & {
      requestBodyValues?: { model?: unknown };
      responseBody?: unknown;
      url?: unknown;
    };
    const model =
      typeof request.requestBodyValues?.model === "string"
        ? request.requestBodyValues.model
        : undefined;
    const url = typeof request.url === "string" ? request.url : undefined;

    if (typeof request.responseBody === "string") {
      try {
        const parsed = JSON.parse(request.responseBody) as { error?: unknown };
        if (typeof parsed.error === "string") {
          if (model && /model .* not found/i.test(parsed.error)) {
            return `Ollama model "${model}" not found. Configure an exact installed model name from \`ollama list\` (for example \`llama3.2:3b\` or \`llama3.2:11b\`).`;
          }
          return parsed.error;
        }
      } catch {
        // Fall through to the generic message.
      }
    }

    if (model && url && error.message === "Not Found") {
      return `Ollama model "${model}" not found at ${url}. Configure an exact installed model name from \`ollama list\`.`;
    }

    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return String(error);
}

function requireGatewayApiKey(config: Config): string {
  const apiKey = config.gatewayApiKey;
  if (!apiKey) {
    throw new GatewayError({
      reason: "Gateway API key not set. Use: pdf-brain config set gateway.apiKey <key>",
    });
  }
  return apiKey;
}

function requireOpenAIApiKey(config: Config): string {
  const apiKey = config.openaiApiKey;
  if (!apiKey) {
    throw new OpenAIError({
      reason: "OpenAI API key not set. Use openai.apiKey or OPENAI_API_KEY.",
    });
  }
  return apiKey;
}

function createConfiguredGatewayProvider(config: Config) {
  return createGateway({
    apiKey: requireGatewayApiKey(config),
  });
}

function createConfiguredOpenAIProvider(config: Config) {
  return createOpenAI({
    apiKey: requireOpenAIApiKey(config),
    baseURL: normalizeBaseUrl(config.openaiBaseUrl) ?? DEFAULT_OPENAI_BASE_URL,
  });
}

function createConfiguredOllamaProvider(config: Config) {
  return createOllama({
    baseURL: normalizeOllamaBaseUrl(config.ollama.host),
    compatibility: "strict",
  });
}

export function getConfiguredEmbeddingModel(
  config: Config,
): ResolvedEmbeddingModel {
  const provider = config.embedding.provider;
  const modelId =
    provider === "openai"
      ? config.embedding.openai.model ?? config.embedding.model
      : config.embedding.model;

  if (provider === "gateway") {
    return {
      provider,
      modelId,
      model: createConfiguredGatewayProvider(config).textEmbeddingModel(modelId),
    };
  }

  if (provider === "openai") {
    return {
      provider,
      modelId,
      model: createConfiguredOpenAIProvider(config).embeddingModel(modelId),
    };
  }

  return {
    provider,
    modelId,
    model: createConfiguredOllamaProvider(config).textEmbeddingModel(modelId),
  };
}

function getConfiguredLanguageConfig(config: Config, role: ConfiguredLanguageRole) {
  if (role === "summary") {
    return config.enrichment;
  }
  return config[role];
}

export function resolveLanguageModel(
  config: Config,
  provider: SupportedProvider,
  modelId: string,
): ResolvedLanguageModel {
  if (provider === "gateway") {
    return {
      provider,
      modelId,
      model: createConfiguredGatewayProvider(config).languageModel(modelId),
    };
  }

  if (provider === "openai") {
    return {
      provider,
      modelId,
      model: createConfiguredOpenAIProvider(config).languageModel(modelId),
    };
  }

  return {
    provider,
    modelId,
    model: createConfiguredOllamaProvider(config).languageModel(modelId),
  };
}

export function getConfiguredLanguageModel(
  config: Config,
  role: ConfiguredLanguageRole,
  override?: { provider?: SupportedProvider; modelId?: string },
): ResolvedLanguageModel {
  const roleConfig = getConfiguredLanguageConfig(config, role);
  const provider = override?.provider ?? roleConfig.provider;
  const modelId = override?.modelId ?? roleConfig.model;
  return resolveLanguageModel(config, provider, modelId);
}
