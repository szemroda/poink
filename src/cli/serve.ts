import { Effect, type Layer } from "effect";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  DEFAULT_SERVER_AUTH_TOKEN_ENV,
  isBearerTokenAuthorized,
  requiresServerAuthForHost,
  resolveServerAuthToken,
  resolveServerConfig,
  type ServerConfigShape,
} from "../agent/protocol.js";
import { type Config, resolveConfigPath } from "../types.js";
import { serveFetch } from "../runtime.js";
import {
  CLIError,
  parseServeCommandOptions,
  type GlobalCLIOptions,
} from "./runner.js";
import { withConfiguredLogging } from "./runtime.js";
import { connectMcpServer } from "./mcp.js";

export function resolveServeSecurityConfig(serverConfig: ServerConfigShape): ServerConfigShape {
  const token = resolveServerAuthToken(serverConfig.auth);
  const tokenEnv = serverConfig.auth.tokenEnv ?? DEFAULT_SERVER_AUTH_TOKEN_ENV;
  const requiresAuth = requiresServerAuthForHost(serverConfig.host);

  if (serverConfig.auth.enabled && !token) {
    throw new CLIError(
      "INVALID_CONFIG",
      `Auth is enabled but no token is configured. Set config.server.auth.token, set ${tokenEnv}, or pass --auth-token.`,
      {
        configPath: resolveConfigPath(),
        tokenEnv,
      },
    );
  }

  if (requiresAuth && !token) {
    throw new CLIError(
      "INVALID_CONFIG",
      `Refusing to bind HTTP MCP server to non-loopback host ${serverConfig.host} without bearer auth. Pass --auth-token, set config.server.auth.token, or set ${tokenEnv}.`,
      {
        host: serverConfig.host,
        configPath: resolveConfigPath(),
        tokenEnv,
      },
    );
  }

  return {
    ...serverConfig,
    auth: {
      ...serverConfig.auth,
      enabled: serverConfig.auth.enabled || requiresAuth,
      token,
    },
  };
}

export async function runServeCommand<E>(
  appLayer: Layer.Layer<unknown, E, never>,
  globals: GlobalCLIOptions,
  serveArgs: string[],
  config: Config,
): Promise<void> {
  const overrides = parseServeCommandOptions(serveArgs);
  const serverConfig = resolveServeSecurityConfig(
    resolveServerConfig(config.server, overrides),
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const closeMcp = await connectMcpServer(appLayer, globals, transport);

  const listener = await serveFetch({
    hostname: serverConfig.host,
    port: serverConfig.port,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            ok: true,
            host: serverConfig.host,
            port: serverConfig.port,
            auth: { enabled: serverConfig.auth.enabled },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.pathname !== "/mcp") {
        return new Response("Not Found", { status: 404 });
      }

      if (!isBearerTokenAuthorized(request.headers, serverConfig.auth)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        });
      }

      return transport.handleRequest(request);
    },
  });

  await Effect.runPromise(
    withConfiguredLogging(
      Effect.gen(function* () {
        yield* Effect.logInfo(
          `[poink:serve] listening on http://${serverConfig.host}:${serverConfig.port}/mcp`,
        );
        yield* Effect.logInfo(
          `[poink:serve] auth ${
            serverConfig.auth.enabled ? "enabled (bearer token)" : "disabled"
          }`,
        );
      }),
      globals.logLevel,
    ),
  );

  const shutdown = async () => {
    try {
      listener.stop(true);
    } catch {
      // ignore
    }
    await closeMcp();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}
