import { describe, expect, test } from "vitest";
import {
  boundaryErrorDetails,
  describeError,
  errorTag,
  MarkdownExtractionError,
  MarkdownNotFoundError,
} from "./errors.js";
import { coerceCliError } from "./cli/errors.js";
import { CLIError } from "./cli/runner.js";

describe("domain error normalization", () => {
  test("renders tagged data errors without object coercion", () => {
    expect(
      describeError(
        new MarkdownExtractionError({
          path: "/tmp/doc.md",
          reason: "permission denied",
        }),
      ),
    ).toBe("permission denied");
    expect(
      describeError(new MarkdownNotFoundError({ path: "/tmp/missing.md" })),
    ).toBe("File not found: /tmp/missing.md");
  });

  test("keeps stable tags and redacts arbitrary causes at boundaries", () => {
    const error = {
      _tag: "ProviderFailure",
      reason: "request rejected",
      apiKey: "secret",
      cause: new Error("socket details"),
    };

    expect(errorTag(error)).toBe("ProviderFailure");
    expect(boundaryErrorDetails(error)).toEqual({ tag: "ProviderFailure" });
  });

  test("uses a stable fallback for non-error values", () => {
    expect(describeError({ unexpected: true })).toBe("UNKNOWN_ERROR");
    expect(errorTag(null)).toBe("UNKNOWN_ERROR");
  });

  test("redacts raw causes already wrapped in CLI errors", () => {
    const error = new CLIError("AUTH_FAILED", "Authentication failed", {
      path: "/tmp/provider.json",
      cause: {
        response: { headers: { authorization: "Bearer secret" } },
        token: "secret",
      },
    });

    expect(coerceCliError(error)).toMatchObject({
      code: "AUTH_FAILED",
      message: "Authentication failed",
      details: { path: "/tmp/provider.json" },
    });
    expect(JSON.stringify(coerceCliError(error))).not.toContain("secret");
  });
});
