import { describe, expect, test } from "vitest";

import { Config, normalizeConfig } from "../types.js";
import {
  describeLanguageModelError,
  getConfiguredEmbeddingModel,
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

});
