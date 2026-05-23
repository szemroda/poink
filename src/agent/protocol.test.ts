import { describe, expect, test } from "vitest";
import {
  DEFAULT_SERVER_AUTH_TOKEN_ENV,
  DEFAULT_SERVER_CONFIG,
  isBearerTokenAuthorized,
  isLoopbackBindHost,
  requiresServerAuthForHost,
  resolveServerAuthToken,
  resolveServerConfig,
} from "./protocol.js";

describe("MCP server config helpers", () => {
  test("defaults to local-only host/port and auth disabled", () => {
    expect(DEFAULT_SERVER_CONFIG.host).toBe("127.0.0.1");
    expect(DEFAULT_SERVER_CONFIG.port).toBe(3838);
    expect(DEFAULT_SERVER_CONFIG.auth.enabled).toBe(false);
    expect(DEFAULT_SERVER_CONFIG.auth.token).toBeUndefined();
    expect(DEFAULT_SERVER_CONFIG.auth.tokenEnv).toBe(DEFAULT_SERVER_AUTH_TOKEN_ENV);
  });

  test("applies CLI overrides for host/port and auth token", () => {
    const resolved = resolveServerConfig(
      {
        host: "127.0.0.1",
        port: 3838,
        auth: {
          enabled: false,
          tokenEnv: "POINK_SERVER_TOKEN",
        },
      },
      {
        host: "0.0.0.0",
        port: 4848,
        authToken: "top-secret",
      },
    );

    expect(resolved.host).toBe("0.0.0.0");
    expect(resolved.port).toBe(4848);
    expect(resolved.auth.enabled).toBe(true);
    expect(resolved.auth.token).toBe("top-secret");
    expect(resolved.auth.tokenEnv).toBe("POINK_SERVER_TOKEN");
  });

  test("resolves server auth token from explicit token before env", () => {
    expect(
      resolveServerAuthToken(
        {
          enabled: true,
          token: "config-token",
          tokenEnv: "POINK_SERVER_TOKEN",
        },
        {
          POINK_SERVER_TOKEN: "env-token",
        },
      ),
    ).toBe("config-token");
  });

  test("resolves server auth token from configured env var", () => {
    expect(
      resolveServerAuthToken(
        {
          enabled: true,
          tokenEnv: "POINK_SERVER_TOKEN",
        },
        {
          POINK_SERVER_TOKEN: "env-token",
        },
      ),
    ).toBe("env-token");
  });
});

describe("MCP server bind security", () => {
  test("treats loopback hosts as local-only", () => {
    expect(isLoopbackBindHost("localhost")).toBe(true);
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("127.10.20.30")).toBe(true);
    expect(isLoopbackBindHost("::1")).toBe(true);
    expect(isLoopbackBindHost("[::1]")).toBe(true);
  });

  test("requires auth for wildcard, LAN, and named non-loopback binds", () => {
    expect(requiresServerAuthForHost("0.0.0.0")).toBe(true);
    expect(requiresServerAuthForHost("::")).toBe(true);
    expect(requiresServerAuthForHost("[::]")).toBe(true);
    expect(requiresServerAuthForHost("192.168.1.10")).toBe(true);
    expect(requiresServerAuthForHost("example.com")).toBe(true);
  });
});

describe("bearer auth", () => {
  test("allows requests when auth is disabled", () => {
    const headers = new Headers();
    expect(
      isBearerTokenAuthorized(headers, {
        enabled: false,
      }),
    ).toBe(true);
  });

  test("rejects missing bearer token when auth is enabled", () => {
    const headers = new Headers();
    expect(
      isBearerTokenAuthorized(headers, {
        enabled: true,
        token: "abc",
      }),
    ).toBe(false);
  });

  test("accepts exact bearer token when auth is enabled", () => {
    const headers = new Headers({
      authorization: "Bearer abc",
    });
    expect(
      isBearerTokenAuthorized(headers, {
        enabled: true,
        token: "abc",
      }),
    ).toBe(true);
  });
});
