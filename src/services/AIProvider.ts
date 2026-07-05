import type {
  EmbeddingModelV3,
  LanguageModelV3,
  LanguageModelV3CallOptions,
} from "@ai-sdk/provider";
import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { GoogleLanguageModelOptions } from "@ai-sdk/google";
import type { OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import type { OpenRouterProviderOptions } from "@openrouter/ai-sdk-provider";
import type { OllamaCompletionProviderOptions } from "ollama-ai-provider-v2";
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
export type ProviderOptions = NonNullable<
  LanguageModelV3CallOptions["providerOptions"]
>;
export type ProviderOptionsInput = {
  readonly providerOptions?: ProviderOptions;
};

export interface ResolvedEmbeddingModel {
  readonly provider: SupportedProvider;
  readonly modelId: string;
  readonly model: EmbeddingModelV3;
}

export interface ResolvedLanguageModel {
  readonly provider: SupportedProvider;
  readonly modelId: string;
  readonly model: LanguageModelV3;
  readonly providerOptions?: ProviderOptions;
}

type GatewayProvider = ReturnType<(typeof import("ai"))["createGateway"]>;
type OpenAIProvider = ReturnType<
  (typeof import("@ai-sdk/openai"))["createOpenAI"]
>;
type OpenRouterProvider = ReturnType<
  (typeof import("@openrouter/ai-sdk-provider"))["createOpenRouter"]
>;
type GoogleProvider = ReturnType<
  (typeof import("@ai-sdk/google"))["createGoogleGenerativeAI"]
>;
type AnthropicProvider = ReturnType<
  (typeof import("@ai-sdk/anthropic"))["createAnthropic"]
>;
type OllamaProvider = ReturnType<
  (typeof import("ollama-ai-provider-v2"))["createOllama"]
>;

const gatewayProviders = new WeakMap<Config, Promise<GatewayProvider>>();
const openAIProviders = new WeakMap<Config, Promise<OpenAIProvider>>();
const openRouterProviders = new WeakMap<Config, Promise<OpenRouterProvider>>();
const googleProviders = new WeakMap<Config, Promise<GoogleProvider>>();
const anthropicProviders = new WeakMap<Config, Promise<AnthropicProvider>>();
const ollamaProviders = new WeakMap<Config, Promise<OllamaProvider>>();
const embeddingModels = new WeakMap<
  Config,
  Map<string, Promise<ResolvedEmbeddingModel>>
>();
const languageModels = new WeakMap<
  Config,
  Map<string, Promise<ResolvedLanguageModel>>
>();

interface PromiseCache<K, V> {
  get(key: K): Promise<V> | undefined;
  set(key: K, value: Promise<V>): unknown;
  delete(key: K): unknown;
}

function cachedValue<K, V>(
  cache: PromiseCache<K, V>,
  key: K,
  create: () => Promise<V>,
): Promise<V> {
  const existing = cache.get(key);
  if (existing) return existing;

  const pending = create().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

function cachedMapValue<V>(
  cache: WeakMap<Config, Map<string, Promise<V>>>,
  config: Config,
  key: string,
  create: () => Promise<V>,
): Promise<V> {
  let values = cache.get(config);
  if (!values) {
    values = new Map();
    cache.set(config, values);
  }

  return cachedValue(values, key, create);
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
  const message = getErrorMessage(error);
  if (!(error instanceof Error)) return message;

  const request = error as Error & {
    requestBodyValues?: { model?: unknown };
    responseBody?: unknown;
    url?: unknown;
  };
  const model = getString(request.requestBodyValues?.model);
  const url = getString(request.url);
  const responseError = parseResponseError(request.responseBody);

  if (responseError) {
    if (model && /model .* not found/i.test(responseError)) {
      return `Ollama model "${model}" not found. Configure an exact installed model name from \`ollama list\` (for example \`llama3.2:3b\` or \`llama3.2:11b\`).`;
    }
    return responseError;
  }

  if (model && url && message === "Not Found") {
    return `Ollama model "${model}" not found at ${url}. Configure an exact installed model name from \`ollama list\`.`;
  }

  return message;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return String(error);
  }
  return getString(error.message) ?? String(error);
}

function parseResponseError(responseBody: unknown): string | undefined {
  if (typeof responseBody !== "string") return undefined;

  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
      return undefined;
    }
    return getString(parsed.error);
  } catch {
    return undefined;
  }
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
  return cachedValue(gatewayProviders, config, async () => {
    const { createGateway } = await import("ai");
    return createGateway({
      apiKey: requireGatewayApiKey(config),
    });
  });
}

function createConfiguredOpenAIProvider(config: Config) {
  return cachedValue(openAIProviders, config, async () => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({
      apiKey: requireOpenAIApiKey(config),
      baseURL:
        normalizeBaseUrl(config.openaiBaseUrl) ?? DEFAULT_OPENAI_BASE_URL,
    });
  });
}

function createConfiguredOpenRouterProvider(config: Config) {
  return cachedValue(openRouterProviders, config, async () => {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    return createOpenRouter({
      apiKey: requireOpenRouterApiKey(config),
      baseURL: normalizeBaseUrl(config.openrouterBaseUrl),
      compatibility: "strict",
    });
  });
}

function createConfiguredGoogleProvider(config: Config) {
  return cachedValue(googleProviders, config, async () => {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    return createGoogleGenerativeAI({
      apiKey: requireGoogleApiKey(config),
      baseURL: normalizeBaseUrl(config.providers.google.baseUrl),
    });
  });
}

function createConfiguredAnthropicProvider(config: Config) {
  return cachedValue(anthropicProviders, config, async () => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({
      apiKey: requireAnthropicApiKey(config),
      baseURL: normalizeBaseUrl(config.providers.anthropic.baseUrl),
    });
  });
}

function createConfiguredOllamaProvider(config: Config) {
  return cachedValue(ollamaProviders, config, async () => {
    const { createOllama } = await import("ollama-ai-provider-v2");
    return createOllama({
      baseURL: normalizeOllamaBaseUrl(config.providers.ollama.baseUrl),
      compatibility: "strict",
    });
  });
}

function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase();
}

function getModelCacheKey(
  provider: SupportedProvider,
  modelId: string,
  variant?: string,
): string {
  return [provider, modelId, variant]
    .filter((part) => part !== undefined)
    .join(":");
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

export function providerOptionsInput(
  resolved: Pick<ResolvedLanguageModel, "providerOptions">,
): ProviderOptionsInput {
  if (!resolved.providerOptions) return {};
  return { providerOptions: resolved.providerOptions };
}

async function createEmbeddingModel(
  config: Config,
  provider: SupportedProvider,
  modelId: string,
): Promise<EmbeddingModelV3> {
  if (provider === "gateway") {
    return (await createConfiguredGatewayProvider(config)).embeddingModel(
      modelId,
    );
  }

  if (provider === "openai") {
    return (await createConfiguredOpenAIProvider(config)).embeddingModel(
      modelId,
    );
  }

  if (provider === "openrouter") {
    return (await createConfiguredOpenRouterProvider(config)).textEmbeddingModel(
      modelId,
    );
  }

  if (provider === "google") {
    return (await createConfiguredGoogleProvider(config)).embedding(modelId);
  }

  if (provider === "anthropic" || provider === "openai-codex") {
    throw new AnthropicError({
      reason:
        "Anthropic does not support embeddings. Configure models.embedding.provider to google, openai, openrouter, gateway, or ollama.",
    });
  }

  return (await createConfiguredOllamaProvider(config)).textEmbeddingModel(
    modelId,
  );
}

async function createLanguageModel(
  config: Config,
  provider: Exclude<SupportedProvider, "openai-codex">,
  modelId: string,
): Promise<LanguageModelV3> {
  if (provider === "gateway") {
    return (await createConfiguredGatewayProvider(config)).languageModel(
      modelId,
    );
  }

  if (provider === "openai") {
    return (await createConfiguredOpenAIProvider(config)).languageModel(
      modelId,
    );
  }

  if (provider === "openrouter") {
    return (await createConfiguredOpenRouterProvider(config)).languageModel(
      modelId,
    );
  }

  if (provider === "google") {
    return (await createConfiguredGoogleProvider(config)).languageModel(
      modelId,
    );
  }

  if (provider === "anthropic") {
    return (await createConfiguredAnthropicProvider(config)).languageModel(
      modelId,
    );
  }

  return (await createConfiguredOllamaProvider(config)).languageModel(
    modelId,
  );
}

export async function getConfiguredEmbeddingModel(
  config: Config,
): Promise<ResolvedEmbeddingModel> {
  const embedding = getModelConfig(config, "embedding");
  const provider = embedding.provider;
  const modelId = embedding.model;
  const cacheKey = getModelCacheKey(provider, modelId);

  return cachedMapValue(embeddingModels, config, cacheKey, async () => {
    return {
      provider,
      modelId,
      model: await createEmbeddingModel(config, provider, modelId),
    };
  });
}

function getConfiguredLanguageConfig(
  config: Config,
  role: ConfiguredLanguageRole,
): Config["models"][ConfiguredLanguageRole] {
  return getModelConfig(config, role);
}

export async function resolveLanguageModel(
  config: Config,
  provider: SupportedProvider,
  modelId: string,
  reasoning?: ReasoningLevel | null,
): Promise<ResolvedLanguageModel> {
  if (provider === "openai-codex") {
    const providerOptions = getReasoningProviderOptions(
      provider,
      modelId,
      reasoning,
    );
    const { getOpenAICodexProviderManager } = await import(
      "./OpenAICodexProvider.js"
    );
    return {
      provider,
      modelId,
      model: getOpenAICodexProviderManager().getLanguageModel(modelId),
      providerOptions,
    };
  }

  const cacheKey = getModelCacheKey(
    provider,
    modelId,
    reasoning ?? "default",
  );

  return cachedMapValue(languageModels, config, cacheKey, async () => {
    const providerOptions = getReasoningProviderOptions(
      provider,
      modelId,
      reasoning,
    );

    return {
      provider,
      modelId,
      model: await createLanguageModel(config, provider, modelId),
      providerOptions,
    };
  });
}

export async function getConfiguredLanguageModel(
  config: Config,
  role: ConfiguredLanguageRole,
  override?: { provider?: SupportedProvider; modelId?: string },
): Promise<ResolvedLanguageModel> {
  const roleConfig = getConfiguredLanguageConfig(config, role);
  const provider = override?.provider ?? roleConfig.provider;
  const modelId = override?.modelId ?? roleConfig.model;
  return resolveLanguageModel(config, provider, modelId, roleConfig.reasoning);
}
