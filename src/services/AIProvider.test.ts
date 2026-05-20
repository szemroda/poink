import { describe, expect, test } from "vitest";

import { Config, normalizeConfig } from "../types.js";
import {
  describeLanguageModelError,
  getConfiguredLanguageModel,
  getConfiguredEmbeddingModel,
  getReasoningProviderOptions,
  normalizeOllamaBaseUrl,
  resolveLanguageModel,
} from "./AIProvider.js";

function makeTestConfig(overrides: Record<string, unknown>) {
  const { models, providers, ...rest } = overrides;
  return normalizeConfig({
    ...JSON.parse(JSON.stringify(Config.Default)),
    ...rest,
    models: {
      ...JSON.parse(JSON.stringify(Config.Default.models)),
      ...(models as Record<string, unknown> | undefined),
    },
    providers: {
      ...JSON.parse(JSON.stringify(Config.Default.providers)),
      ...(providers as Record<string, unknown> | undefined),
    },
  });
}

describe("AIProvider", () => {
  test("appends /api to a plain Ollama host", () => {
    expect(normalizeOllamaBaseUrl("http://localhost:11434")).toBe(
      "http://localhost:11434/api"
    );
  });

  test("preserves an Ollama host that already ends with /api", () => {
    expect(normalizeOllamaBaseUrl("http://localhost:11434/api")).toBe(
      "http://localhost:11434/api"
    );
  });

  test("trims a trailing slash before appending /api", () => {
    expect(normalizeOllamaBaseUrl("http://localhost:11434/")).toBe(
      "http://localhost:11434/api"
    );
  });

  test("formats missing Ollama model errors with the exact configured model", () => {
    const error = Object.assign(new Error("Not Found"), {
      requestBodyValues: { model: "llama3.2" },
      url: "http://localhost:11434/api/chat",
      responseBody: JSON.stringify({ error: "model 'llama3.2' not found" }),
    });

    expect(describeLanguageModelError(error)).toContain(
      'Ollama model "llama3.2" not found.'
    );
    expect(describeLanguageModelError(error)).toContain("ollama list");
    expect(describeLanguageModelError(error)).toContain("llama3.2:3b");
  });

  test("resolves OpenRouter language models through the provider abstraction", () => {
    const config = makeTestConfig({
      providers: {
        openrouter: {
          apiKey: "test-openrouter-key",
        },
      },
    });

    const resolved = resolveLanguageModel(
      config,
      "openrouter",
      "anthropic/claude-3.5-haiku"
    );

    expect(resolved.provider).toBe("openrouter");
    expect(resolved.modelId).toBe("anthropic/claude-3.5-haiku");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.model.modelId).toBe("anthropic/claude-3.5-haiku");
  });

  test("resolves OpenRouter embedding models through the provider abstraction", () => {
    const config = makeTestConfig({
      models: {
        embedding: {
          provider: "openrouter",
          model: "openai/text-embedding-3-small",
        },
      },
      providers: {
        openrouter: {
          apiKey: "test-openrouter-key",
        },
      },
    });

    const resolved = getConfiguredEmbeddingModel(config);

    expect(resolved.provider).toBe("openrouter");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.modelId).toBe("openai/text-embedding-3-small");
    expect(resolved.model.modelId).toBe("openai/text-embedding-3-small");
  });

  test("resolves Google language models through the provider abstraction", () => {
    const config = makeTestConfig({
      providers: {
        google: {
          apiKey: "test-google-key",
        },
      },
    });

    const resolved = resolveLanguageModel(config, "google", "gemini-2.5-flash");

    expect(resolved.provider).toBe("google");
    expect(resolved.modelId).toBe("gemini-2.5-flash");
    expect(resolved.model.provider).toBe("google.generative-ai");
    expect(resolved.model.modelId).toBe("gemini-2.5-flash");
  });

  test("resolves Google embedding models through the provider abstraction", () => {
    const config = makeTestConfig({
      models: {
        embedding: {
          provider: "google",
          model: "gemini-embedding-001",
        },
      },
      providers: {
        google: {
          apiKey: "test-google-key",
        },
      },
    });

    const resolved = getConfiguredEmbeddingModel(config);

    expect(resolved.provider).toBe("google");
    expect(resolved.model.provider).toBe("google.generative-ai");
    expect(resolved.modelId).toBe("gemini-embedding-001");
    expect(resolved.model.modelId).toBe("gemini-embedding-001");
  });

  test("resolves Anthropic language models through the provider abstraction", () => {
    const config = makeTestConfig({
      providers: {
        anthropic: {
          apiKey: "test-anthropic-key",
        },
      },
    });

    const resolved = resolveLanguageModel(
      config,
      "anthropic",
      "claude-3-5-haiku-20241022",
    );

    expect(resolved.provider).toBe("anthropic");
    expect(resolved.modelId).toBe("claude-3-5-haiku-20241022");
    expect(resolved.model.provider).toBe("anthropic.messages");
    expect(resolved.model.modelId).toBe("claude-3-5-haiku-20241022");
  });

  test("omits reasoning provider options when reasoning is not configured", () => {
    expect(getReasoningProviderOptions("openai", "gpt-5.2", null)).toBeUndefined();
    expect(
      getReasoningProviderOptions("openai", "gpt-5.2", undefined),
    ).toBeUndefined();
  });

  test("maps reasoning levels to provider-specific options", () => {
    expect(getReasoningProviderOptions("openai", "gpt-5.2", "high")).toEqual({
      openai: { reasoningEffort: "high" },
    });
    expect(getReasoningProviderOptions("openrouter", "openai/gpt-5", "low")).toEqual({
      openrouter: { reasoning: { effort: "low" } },
    });
    expect(
      getReasoningProviderOptions("google", "gemini-3-pro-preview", "medium"),
    ).toEqual({
      google: { thinkingConfig: { thinkingLevel: "medium" } },
    });
  });

  test("passes configured language model reasoning through resolved provider options", () => {
    const config = makeTestConfig({
      models: {
        enrichment: {
          provider: "openai",
          model: "gpt-5.2",
          reasoning: "high",
        },
      },
      providers: {
        openai: {
          apiKey: "test-openai-key",
        },
      },
    });

    const resolved = getConfiguredLanguageModel(config, "enrichment");

    expect(resolved.providerOptions).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  test("maps reasoning none to instant or non-thinking provider options", () => {
    expect(getReasoningProviderOptions("openai", "gpt-5.2", "none")).toEqual({
      openai: { reasoningEffort: "none" },
    });
    expect(getReasoningProviderOptions("openrouter", "openai/gpt-5", "none")).toEqual({
      openrouter: { reasoning: { effort: "none" } },
    });
    expect(getReasoningProviderOptions("ollama", "qwen3:8b", "none")).toEqual({
      ollama: { think: false },
    });
  });

  test("does not block reasoning options for any configured model id", () => {
    expect(getReasoningProviderOptions("openai", "gpt-4o-mini", "high")).toEqual({
      openai: { reasoningEffort: "high" },
    });
    expect(
      getReasoningProviderOptions("anthropic", "claude-3-5-haiku-20241022", "high"),
    ).toEqual({
      anthropic: { effort: "high" },
    });
    expect(getReasoningProviderOptions("ollama", "llama3.2:3b", "medium")).toEqual({
      ollama: { think: true },
    });
  });

  test("uses the gateway target provider when mapping reasoning options", () => {
    expect(getReasoningProviderOptions("gateway", "openai/gpt-5.2", "high")).toEqual({
      openai: { reasoningEffort: "high" },
    });
    expect(
      getReasoningProviderOptions("gateway", "anthropic/claude-opus-4-6", "low"),
    ).toEqual({
      anthropic: { effort: "low" },
    });
  });

});
