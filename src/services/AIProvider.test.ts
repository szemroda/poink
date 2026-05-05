import { describe, expect, test } from "bun:test";

import { describeLanguageModelError, normalizeOllamaBaseUrl } from "./AIProvider.js";

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
});
