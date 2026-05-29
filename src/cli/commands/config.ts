import { Effect } from "effect";
import {
  Config,
  loadConfig,
  normalizeConfig,
  resolveConfigPath,
  saveConfig,
} from "../../types.js";
import { getOpenAICodexConfiguredRoles } from "../../services/OpenAICodexProvider.js";
import { resolveServerAuthToken } from "../../agent/protocol.js";
import {
  CLIError,
} from "../runner.js";
import {
  getConfigSchemaNode,
  invalidConfigPathError,
  parseConfigOutputOptions,
  parseConfigValue,
  redactConfigObject,
  redactConfigValue,
} from "../configValues.js";
import type { CliCommandOutput, CliConsole } from "./types.js";

export function runConfigCommand(args: string[], Console: CliConsole) {
  return Effect.gen(function* (): Generator<any, CliCommandOutput, any> {
    const configOutputOptions = parseConfigOutputOptions(args.slice(1));
    const configArgs = ["config", ...configOutputOptions.args];
    const subcommand = configArgs[1];
    const showSecrets = configOutputOptions.showSecrets;
    const config = loadConfig();
    const configPath = resolveConfigPath();
    let resultPayload: unknown = null;

    if (!subcommand || subcommand === "show") {
      const openAICodexRoles = getOpenAICodexConfiguredRoles(config);
      const hasResolvedServerAuthToken = Boolean(resolveServerAuthToken(config.server.auth));
      yield* Console.log(`PDF Library Config (${configPath})`);
      yield* Console.log(
        `-------------------------------------------------------------------`,
      );
      yield* Console.log(
        `Embedding:   ${config.models.embedding.provider} / ${config.models.embedding.model}`,
      );
      yield* Console.log(
        `Enrichment:  ${config.models.enrichment.provider} / ${config.models.enrichment.model} (reasoning: ${
          config.models.enrichment.reasoning ?? "provider default"
        })`,
      );
      yield* Console.log(
        `Judge:       ${config.models.judge.provider} / ${config.models.judge.model} (reasoning: ${
          config.models.judge.reasoning ?? "provider default"
        })`,
      );
      yield* Console.log(
        `OpenAI Codex:${openAICodexRoles.length > 0 ? ` configured for ${openAICodexRoles.join(", ")}` : " not configured for language roles"}`,
      );
      yield* Console.log("");
      yield* Console.log(
        `Ollama:      ${config.providers.ollama.baseUrl} (auto-pull: ${
          config.providers.ollama.autoPull ? "on" : "off"
        })`,
      );
      yield* Console.log("");
      yield* Console.log(`Storage:     ${config.storage.backend}`);
      yield* Console.log(
        `Qdrant:      ${config.storage.qdrant.url} / ${config.storage.qdrant.collection}`,
      );
      yield* Console.log("");
      yield* Console.log(`CLI Format:  ${config.cli.globalFlags.format}`);
      yield* Console.log(
        `URL Downloads: max ${config.ingest.urlDownloads.maxFileSize}, timeout ${config.ingest.urlDownloads.timeout}, redirects ${config.ingest.urlDownloads.maxRedirects}`,
      );
      yield* Console.log(
        `Visuals:     ${config.ingest.visuals.enabled ? "enabled" : "disabled"}, max image ${config.ingest.visuals.maxImageBytes}, max images/doc ${config.ingest.visuals.maxImagesPerDocument}`,
      );
      yield* Console.log("");
      yield* Console.log(`Server:      ${config.server.host}:${config.server.port}`);
      yield* Console.log(
        `Auth:        ${
          config.server.auth.enabled ? "enabled" : "disabled"
        }${hasResolvedServerAuthToken ? " (token set)" : ""}`,
      );
      yield* Console.log(`Auth Env:    ${config.server.auth.tokenEnv}`);
      yield* Console.log("");
      const hasGatewayKey = config.gatewayApiKey;
      const hasOpenRouterKey = config.openrouterApiKey;
      const hasGoogleKey = config.googleApiKey;
      const hasAnthropicKey = config.anthropicApiKey;
      yield* Console.log(
        hasGatewayKey
          ? `Gateway:     API key configured`
          : `Gateway:     No API key (set via: poink config set providers.gateway.apiKey <key>)`,
      );
      yield* Console.log(
        hasOpenRouterKey
          ? `OpenRouter:  API key configured`
          : `OpenRouter:  No API key (set via: poink config set providers.openrouter.apiKey <key>)`,
      );
      yield* Console.log(
        hasGoogleKey
          ? `Google:      API key configured`
          : `Google:      No API key (set via: poink config set providers.google.apiKey <key>)`,
      );
      yield* Console.log(
        hasAnthropicKey
          ? `Anthropic:  API key configured`
          : `Anthropic:  No API key (set via: poink config set providers.anthropic.apiKey <key>)`,
      );
      resultPayload = {
        configPath,
        config: showSecrets ? config : redactConfigObject(config),
        gatewayApiKeyConfigured: Boolean(hasGatewayKey),
        openrouterApiKeyConfigured: Boolean(hasOpenRouterKey),
        googleApiKeyConfigured: Boolean(hasGoogleKey),
        anthropicApiKeyConfigured: Boolean(hasAnthropicKey),
        openAICodex: {
          roles: openAICodexRoles,
          runtime: "bundled",
        },
        cli: {
          defaultFormat: config.cli.globalFlags.format,
        },
      };
    } else if (subcommand === "get") {
      const path = configArgs[2];
      if (!path) {
        yield* Console.error("Error: Path required");
        yield* Console.error("Usage: poink config get <path>");
        yield* Console.error("Example: poink config get models.embedding.model");
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", "Path required", {
            command: "config get",
            hint: "poink config get models.embedding.model",
          }),
        );
      }

      const parts = path.split(".");
      let value: any = config;
      for (const part of parts) {
        if (value && typeof value === "object" && part in value) {
          value = value[part];
        } else {
          yield* Console.error(`Config path not found: ${path}`);
          return yield* Effect.fail(
            new CLIError("NOT_FOUND", `Config path not found: ${path}`, {
              path,
            }),
          );
        }
      }

      const outputValue = redactConfigValue(path, value, showSecrets);
      yield* Console.log(
        typeof outputValue === "object" ? JSON.stringify(outputValue) : String(outputValue),
      );
      resultPayload = { path, value: outputValue };
    } else if (subcommand === "set") {
      const path = configArgs[2];
      const newValue = configArgs[3];

      if (!path || newValue === undefined) {
        yield* Console.error("Error: Path and value required");
        yield* Console.error("Usage: poink config set <path> <value>");
        yield* Console.error(
          "Example: poink config set models.embedding.model nomic-embed-text",
        );
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", "Path and value required", {
            command: "config set",
            hint: "poink config set models.embedding.model nomic-embed-text",
          }),
        );
      }

      const schemaNode = getConfigSchemaNode(path);
      if (!schemaNode) {
        yield* Console.error(`Invalid config path: ${path}`);
        return yield* Effect.fail(invalidConfigPathError(path));
      }

      const parts = path.split(".");
      const updatedConfig = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
      let target: Record<string, unknown> | undefined = updatedConfig;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        const next = target?.[part];
        if (next && typeof next === "object" && !Array.isArray(next)) {
          target = next as Record<string, unknown>;
        } else {
          yield* Console.error(`Invalid config path: ${path}`);
          return yield* Effect.fail(invalidConfigPathError(path));
        }
      }

      if (!target) {
        yield* Console.error(`Invalid config path: ${path}`);
        return yield* Effect.fail(invalidConfigPathError(path));
      }

      const lastPart = parts[parts.length - 1]!;
      const parsedValue = parseConfigValue(path, newValue, schemaNode);
      target[lastPart] = parsedValue;

      let validatedConfig: Config;
      try {
        validatedConfig = normalizeConfig(updatedConfig);
      } catch {
        yield* Console.error(`Invalid value for config path: ${path}`);
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", `Invalid value for config path: ${path}`, {
            path,
            value: newValue,
          }),
        );
      }

      saveConfig(validatedConfig);
      const outputValue = redactConfigValue(path, parsedValue, showSecrets);
      yield* Console.log(`Updated ${path}: ${outputValue}`);
      resultPayload = { path, value: outputValue };
    } else {
      yield* Console.error(`Unknown config subcommand: ${subcommand}`);
      yield* Console.error("Available: show, get, set");
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", `Unknown config subcommand: ${subcommand}`, {
          subcommand,
          available: ["show", "get", "set"],
        }),
      );
    }

    return {
      resultPayload,
      agentResult: { _tag: "config", subcommand: subcommand || "show" },
    };
  });
}
