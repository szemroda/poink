import { describe, expect, test } from "vitest";
import {
  isBearerTokenAuthorized,
  makeErrorEnvelope,
  makeSuccessEnvelope,
  requiresServerAuthForHost,
  resolveServerAuthToken,
  resolveServerConfig,
  type ServerAuthConfig,
} from "./protocol.js";

describe("agent envelopes", () => {
  const error = { code: "NOT_FOUND", message: "Missing", details: { id: "doc-1" } };
  const nextActions = [{ kind: "shell" as const, argv: ["poink", "list"] }];
  const meta = {
    poinkVersion: "1.0.0",
    timing: { totalMs: 12.345, commandMs: 1.234 },
  };

  test("omits diagnostics by default", () => {
    expect(makeSuccessEnvelope("stats", { documents: 1 }, { nextActions, meta })).toEqual({
      ok: true,
      command: "stats",
      result: { documents: 1 },
    });
    expect(makeErrorEnvelope("read", error, { meta })).toEqual({
      ok: false,
      command: "read",
      error: { code: "NOT_FOUND", message: "Missing" },
    });
  });

  test("adds next actions, meta, and error details in verbose mode", () => {
    expect(
      makeSuccessEnvelope("stats", {}, { verbose: true, nextActions, meta }),
    ).toEqual({ ok: true, command: "stats", result: {}, nextActions, meta });
    expect(makeErrorEnvelope("read", error, { verbose: true, meta })).toEqual({
      ok: false,
      command: "read",
      error,
      meta,
    });
  });
});

describe("server config", () => {
  test("defaults to a local-only bind with auth disabled", () => {
    expect(resolveServerConfig(undefined)).toEqual({
      host: "127.0.0.1",
      port: 3838,
      auth: { enabled: false, token: undefined, tokenEnv: "POINK_SERVER_TOKEN" },
    });
  });

  test("CLI overrides replace host and port, and a token enables auth", () => {
    expect(
      resolveServerConfig(
        {
          host: "127.0.0.1",
          port: 3838,
          auth: { enabled: false, tokenEnv: "CUSTOM_TOKEN" },
        },
        { host: "0.0.0.0", port: 4848, authToken: "top-secret" },
      ),
    ).toEqual({
      host: "0.0.0.0",
      port: 4848,
      auth: { enabled: true, token: "top-secret", tokenEnv: "CUSTOM_TOKEN" },
    });
  });

  test.each([
    ["an explicit token over the env var", { enabled: true, token: "config-token", tokenEnv: "POINK_SERVER_TOKEN" }, "config-token"],
    ["the configured env var", { enabled: true, tokenEnv: "POINK_SERVER_TOKEN" }, "env-token"],
    ["nothing without a token or env var", { enabled: true }, undefined],
  ])("resolves the auth token from %s", (_name, auth: ServerAuthConfig, expected) => {
    expect(resolveServerAuthToken(auth, { POINK_SERVER_TOKEN: "env-token" })).toBe(expected);
  });

  test.each([
    ["localhost", false],
    ["127.0.0.1", false],
    ["127.10.20.30", false],
    ["::1", false],
    ["[::1]", false],
    ["0.0.0.0", true],
    ["::", true],
    ["[::]", true],
    ["192.168.1.10", true],
    ["example.com", true],
  ])("requires auth for bind host %s: %s", (host, expected) => {
    expect(requiresServerAuthForHost(host)).toBe(expected);
  });
});

describe("bearer auth", () => {
  test.each([
    ["allows any request when auth is disabled", undefined, { enabled: false }, true],
    ["rejects a missing token", undefined, { enabled: true, token: "abc" }, false],
    ["rejects a wrong token", "Bearer abcd", { enabled: true, token: "abc" }, false],
    // "Bearer undefined" is what a naive `Bearer ${token}` comparison would accept.
    ["rejects everything when no token is configured", "Bearer undefined", { enabled: true }, false],
    ["accepts the exact token", "Bearer abc", { enabled: true, token: "abc" }, true],
  ])("%s", (_name, authorization: string | undefined, auth: ServerAuthConfig, expected) => {
    const headers = new Headers(authorization ? { authorization } : {});
    expect(isBearerTokenAuthorized(headers, auth)).toBe(expected);
  });
});
