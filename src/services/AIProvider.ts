import { createGateway } from "ai";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import {
  createAnthropic,
  type AnthropicLanguageModelOptions,
} from "@ai-sdk/anthropic";
import {
  createGoogleGenerativeAI,
  type GoogleLanguageModelOptions,
} from "@ai-sdk/google";
import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
} from "@ai-sdk/openai";
import {
  createOpenRouter,
  type OpenRouterProviderOptions,
} from "@openrouter/ai-sdk-provider";
import {
  createOllama,
  type OllamaCompletionProviderOptions,
} from "ollama-ai-provider-v2";
import {
  AnthropicError,
  GatewayError,
  GoogleError,
  type Config,
  OllamaError,
  OpenAIError,
  OpenAICodexError,
  OpenRouterError,
  type ReasoningLevel,
  getModelConfig,
} from "../types.js";
import { getOpenAICodexProviderManager } from "./OpenAICodexProvider.js";

export type SupportedProvider =
  | "ollama"
  | "openai"
  | "gateway"
  | "openrouter"
  | "google"
  | "anthropic"
  | "openai-codex";
export type ProviderError =
  | AnthropicError
  | GatewayError
  | GoogleError
  | OllamaError
  | OpenAIError
  | OpenAICodexError
  | OpenRouterError;
export type ConfiguredLanguageRole = "enrichment" | "judge";
type ReasoningTargetProvider = Exclude<SupportedProvider, "gateway">;
type ProviderOptions = NonNullable<LanguageModelV3CallOptions["providerOptions"]>;

export interface ResolvedEmbeddingModel {
  readonly provider: SupportedProvider;
  readonly modelId: string;
  readonly model: any;
}

export interface ResolvedLanguageModel {
  readonly provider: SupportedProvider;
  readonly modelId: string;
  readonly model: any;
  readonly providerOptions?: ProviderOptions;
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
      reason:
        "Gateway API key not set. Use: poink config set providers.gateway.apiKey <key> or set AI_GATEWAY_API_KEY.",
    });
  }
  return apiKey;
}

function requireOpenAIApiKey(config: Config): string {
  const apiKey = config.openaiApiKey;
  if (!apiKey) {
    throw new OpenAIError({
      reason: "OpenAI API key not set. Use providers.openai.apiKey or OPENAI_API_KEY.",
    });
  }
  return apiKey;
}

function requireOpenRouterApiKey(config: Config): string {
  const apiKey = config.openrouterApiKey;
  if (!apiKey) {
    throw new OpenRouterError({
      reason:
        "OpenRouter API key not set. Use providers.openrouter.apiKey or OPENROUTER_API_KEY.",
    });
  }
  return apiKey;
}

function requireGoogleApiKey(config: Config): string {
  const apiKey = config.googleApiKey;
  if (!apiKey) {
    throw new GoogleError({
      reason:
        "Google Generative AI API key not set. Use providers.google.apiKey or GOOGLE_GENERATIVE_AI_API_KEY.",
    });
  }
  return apiKey;
}

function requireAnthropicApiKey(config: Config): string {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    throw new AnthropicError({
      reason:
        "Anthropic API key not set. Use providers.anthropic.apiKey or ANTHROPIC_API_KEY.",
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

function createConfiguredOpenRouterProvider(config: Config) {
  return createOpenRouter({
    apiKey: requireOpenRouterApiKey(config),
    baseURL: normalizeBaseUrl(config.openrouterBaseUrl),
    compatibility: "strict",
  });
}

function createConfiguredGoogleProvider(config: Config) {
  return createGoogleGenerativeAI({
    apiKey: requireGoogleApiKey(config),
    baseURL: normalizeBaseUrl(config.providers.google.baseUrl),
  });
}

function createConfiguredAnthropicProvider(config: Config) {
  return createAnthropic({
    apiKey: requireAnthropicApiKey(config),
    baseURL: normalizeBaseUrl(config.providers.anthropic.baseUrl),
  });
}

function createConfiguredOllamaProvider(config: Config) {
  return createOllama({
    baseURL: normalizeOllamaBaseUrl(config.providers.ollama.baseUrl),
    compatibility: "strict",
  });
}

function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase();
}

function inferGatewayTargetProvider(
  modelId: string,
): ReasoningTargetProvider | undefined {
  const prefix = normalizeModelId(modelId).split("/")[0];
  if (
    prefix === "openai" ||
    prefix === "anthropic" ||
    prefix === "google" ||
    prefix === "openrouter" ||
    prefix === "ollama" ||
    prefix === "openai-codex"
  ) {
    return prefix;
  }
  return undefined;
}

export function getReasoningProviderOptions(
  provider: SupportedProvider,
  modelId: string,
  reasoning: ReasoningLevel | null | undefined,
): ProviderOptions | undefined {
  if (reasoning == null) return undefined;

  const targetProvider =
    provider === "gateway" ? inferGatewayTargetProvider(modelId) : provider;

  if (targetProvider === "openai") {
    const openai = {
      reasoningEffort: reasoning,
    } satisfies OpenAILanguageModelResponsesOptions;
    return {
      openai,
    };
  }

  if (targetProvider === "openrouter") {
    const openrouter = {
      reasoning: {
        effort: reasoning,
      },
    } satisfies OpenRouterProviderOptions;
    return {
      openrouter,
    };
  }

  if (targetProvider === "google") {
    const google = (
      reasoning === "none"
        ? { thinkingConfig: { thinkingBudget: 0 } }
        : { thinkingConfig: { thinkingLevel: reasoning } }
    ) satisfies GoogleLanguageModelOptions;
    return {
      google,
    };
  }

  if (targetProvider === "anthropic") {
    const anthropic = (
      reasoning === "none"
        ? { thinking: { type: "disabled" } }
        : { effort: reasoning }
    ) satisfies AnthropicLanguageModelOptions;
    return {
      anthropic,
    };
  }

  if (targetProvider === "ollama") {
    const ollama = {
      think: reasoning !== "none",
    } satisfies OllamaCompletionProviderOptions;
    return { ollama };
  }

  if (targetProvider === "openai-codex") {
    return {
      "codex-app-server": {
        effort: reasoning,
      },
    };
  }

  return undefined;
}

export function getConfiguredEmbeddingModel(
  config: Config,
): ResolvedEmbeddingModel {
  const embedding = getModelConfig(config, "embedding");
  const provider = embedding.provider;
  const modelId = embedding.model;

  if (provider === "gateway") {
    return {
      provider,
      modelId,
      model: createConfiguredGatewayProvider(config).embeddingModel(modelId),
    };
  }

  if (provider === "openai") {
    return {
      provider,
      modelId,
      model: createConfiguredOpenAIProvider(config).embeddingModel(modelId),
    };
  }

  if (provider === "openrouter") {
    return {
      provider,
      modelId,
      model: createConfiguredOpenRouterProvider(config).textEmbeddingModel(modelId),
    };
  }

  if (provider === "google") {
    return {
      provider,
      modelId,
      model: createConfiguredGoogleProvider(config).embedding(modelId),
    };
  }

  if (provider === "anthropic") {
    throw new AnthropicError({
      reason:
        "Anthropic does not support embeddings. Configure models.embedding.provider to google, openai, openrouter, gateway, or ollama.",
    });
  }

  return {
    provider,
    modelId,
    model: createConfiguredOllamaProvider(config).textEmbeddingModel(modelId),
  };
}

function getConfiguredLanguageConfig(
  config: Config,
  role: ConfiguredLanguageRole,
): Config["models"][ConfiguredLanguageRole] {
  return getModelConfig(config, role);
}

export function resolveLanguageModel(
  config: Config,
  provider: SupportedProvider,
  modelId: string,
  reasoning?: ReasoningLevel | null,
): ResolvedLanguageModel {
  const providerOptions = getReasoningProviderOptions(provider, modelId, reasoning);

  if (provider === "gateway") {
    return {
      provider,
      modelId,
      model: createConfiguredGatewayProvider(config).languageModel(modelId),
      providerOptions,
    };
  }

  if (provider === "openai") {
    return {
      provider,
      modelId,
      model: createConfiguredOpenAIProvider(config).languageModel(modelId),
      providerOptions,
    };
  }

  if (provider === "openai-codex") {
    return {
      provider,
      modelId,
      model: getOpenAICodexProviderManager().getLanguageModel(modelId),
      providerOptions,
    };
  }

  if (provider === "openrouter") {
    return {
      provider,
      modelId,
      model: createConfiguredOpenRouterProvider(config).languageModel(modelId),
      providerOptions,
    };
  }

  if (provider === "google") {
    return {
      provider,
      modelId,
      model: createConfiguredGoogleProvider(config).languageModel(modelId),
      providerOptions,
    };
  }

  if (provider === "anthropic") {
    return {
      provider,
      modelId,
      model: createConfiguredAnthropicProvider(config).languageModel(modelId),
      providerOptions,
    };
  }

  return {
    provider,
    modelId,
    model: createConfiguredOllamaProvider(config).languageModel(modelId),
    providerOptions,
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
  return resolveLanguageModel(config, provider, modelId, roleConfig.reasoning);
}
