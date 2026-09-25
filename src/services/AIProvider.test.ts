import { afterEach, describe, expect, test } from "vitest";

import { Config, normalizeConfig } from "../types.js";
import {
  describeLanguageModelError,
  getConfiguredLanguageModel,
  getConfiguredEmbeddingModel,
  normalizeOllamaBaseUrl,
  resolveLanguageModel,
  type SupportedProvider,
} from "./AIProvider.js";
import { closeOpenAICodexProviderManager } from "./OpenAICodexProvider.js";

afterEach(async () => {
  await closeOpenAICodexProviderManager();
});

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

describe("Ollama base URL normalization", () => {
  test.each([
    ["http://localhost:11434", "http://localhost:11434/api"],
    ["http://localhost:11434/", "http://localhost:11434/api"],
    ["http://localhost:11434/api", "http://localhost:11434/api"],
    [" ", undefined],
  ])("AI SDK URL for %j is %j", (input, expected) => {
    expect(normalizeOllamaBaseUrl(input)).toBe(expected);
  });
});

describe("describeLanguageModelError", () => {
  test.each([
    [
      "names the missing model from the response body",
      Object.assign(new Error("Not Found"), {
        requestBodyValues: { model: "llama3.2" },
        url: "http://localhost:11434/api/chat",
        responseBody: JSON.stringify({ error: "model 'llama3.2' not found" }),
      }),
      'Ollama model "llama3.2" not found. Configure an exact installed model name from `ollama list`',
    ],
    [
      "names the missing model and URL for a bare 404",
      Object.assign(new Error("Not Found"), {
        requestBodyValues: { model: "llama3.2" },
        url: "http://localhost:11434/api/chat",
      }),
      'Ollama model "llama3.2" not found at http://localhost:11434/api/chat.',
    ],
    [
      "surfaces other response body errors",
      Object.assign(new Error("Bad Request"), {
        responseBody: JSON.stringify({ error: "context length exceeded" }),
      }),
      "context length exceeded",
    ],
  ])("%s", (_name, error, expected) => {
    expect(describeLanguageModelError(error)).toContain(expected);
  });
});

describe("model resolution", () => {
  test.each<[SupportedProvider, Record<string, unknown>, string, string]>([
    ["openrouter", { openrouter: { apiKey: "test-key" } }, "anthropic/claude-3.5-haiku", "openrouter"],
    ["google", { google: { apiKey: "test-key" } }, "gemini-2.5-flash", "google.generative-ai"],
    ["anthropic", { anthropic: { apiKey: "test-key" } }, "claude-3-5-haiku-20241022", "anthropic.messages"],
    ["openai-codex", { "openai-codex": { codexPath: process.execPath } }, "gpt-5.5", "codex-app-server"],
  ])("resolves %s language models", async (provider, providers, modelId, sdkProvider) => {
    const resolved = await resolveLanguageModel(makeTestConfig({ providers }), provider, modelId);

    expect(resolved).toMatchObject({
      provider,
      modelId,
      model: { provider: sdkProvider, modelId },
    });
  });

  test.each<[SupportedProvider, Record<string, unknown>, string, string]>([
    ["openrouter", { openrouter: { apiKey: "test-key" } }, "openai/text-embedding-3-small", "openrouter"],
    ["google", { google: { apiKey: "test-key" } }, "gemini-embedding-001", "google.generative-ai"],
  ])("resolves %s embedding models", async (provider, providers, modelId, sdkProvider) => {
    const config = makeTestConfig({
      models: { embedding: { provider, model: modelId } },
      providers,
    });

    expect(await getConfiguredEmbeddingModel(config)).toMatchObject({
      provider,
      modelId,
      model: { provider: sdkProvider, modelId },
    });
  });

  test("caches resolved models for one config snapshot", async () => {
    const config = makeTestConfig({
      models: { embedding: { provider: "google", model: "gemini-embedding-001" } },
      providers: { google: { apiKey: "test-key" } },
    });

    const [firstLanguage, secondLanguage, firstEmbedding, secondEmbedding] = await Promise.all([
      resolveLanguageModel(config, "google", "gemini-2.5-flash"),
      resolveLanguageModel(config, "google", "gemini-2.5-flash"),
      getConfiguredEmbeddingModel(config),
      getConfiguredEmbeddingModel(config),
    ]);

    expect(secondLanguage).toBe(firstLanguage);
    expect(secondEmbedding).toBe(firstEmbedding);
  });

  test("passes the configured role and reasoning through", async () => {
    const config = makeTestConfig({
      models: {
        enrichment: { provider: "openai", model: "gpt-5.2", reasoning: "xhigh" },
      },
      providers: { openai: { apiKey: "test-openai-key" } },
    });

    expect(await getConfiguredLanguageModel(config, "enrichment")).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.2",
      reasoning: "xhigh",
    });
  });
});
