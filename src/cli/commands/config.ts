import { Effect } from "effect";
import {
  Config,
  normalizeConfig,
  resolveConfigPath,
  saveConfig,
} from "../../types.js";
import { resolveServerAuthToken } from "../../agent/protocol.js";
import { CLIError } from "../runner.js";
import {
  CONFIG_JSON_SCHEMA,
  getConfigSchemaNode,
  invalidConfigPathError,
  parseConfigOutputOptions,
  parseConfigValue,
  redactConfigObject,
  redactConfigValue,
} from "../configValues.js";
import type { CliConsole } from "./types.js";

type ConfigRole = "enrichment" | "judge";

function getOpenAICodexConfiguredRoles(
  config: Config,
): ConfigRole[] {
  const roles: ConfigRole[] = [];
  if (config.models.enrichment.provider === "openai-codex") {
    roles.push("enrichment");
  }
  if (config.models.judge.provider === "openai-codex") {
    roles.push("judge");
  }
  return roles;
}

function logLines(Console: CliConsole, lines: string[]) {
  return Effect.forEach(lines, (line) => Console.log(line), { discard: true });
}

function errorLines(Console: CliConsole, lines: string[]) {
  return Effect.forEach(lines, (line) => Console.error(line), { discard: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getValueAtPath(
  source: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  let value = source;
  for (const part of path.split(".")) {
    if (!isRecord(value) || !(part in value)) {
      return { found: false };
    }
    value = value[part];
  }
  return { found: true, value };
}

function cloneConfig(config: Config): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

function setValueAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): boolean {
  const parts = path.split(".");
  let parent = target;

  for (const part of parts.slice(0, -1)) {
    const next = parent[part];
    if (!isRecord(next)) {
      return false;
    }
    parent = next;
  }

  const leaf = parts.at(-1);
  if (!leaf) {
    return false;
  }
  parent[leaf] = value;
  return true;
}

function runShowConfig(
  Console: CliConsole,
  config: Config,
  showSecrets: boolean,
) {
  return Effect.gen(function* () {
    const configPath = resolveConfigPath();
    const openAICodexRoles = getOpenAICodexConfiguredRoles(config);
    const hasResolvedServerAuthToken = Boolean(
      resolveServerAuthToken(config.server.auth),
    );
    const hasGatewayKey = config.gatewayApiKey;
    const hasOpenRouterKey = config.openrouterApiKey;
    const hasGoogleKey = config.googleApiKey;
    const hasAnthropicKey = config.anthropicApiKey;

    yield* logLines(Console, [
      `PDF Library Config (${configPath})`,
      "-------------------------------------------------------------------",
      `Embedding:   ${config.models.embedding.provider} / ${config.models.embedding.model}`,
      `Enrichment:  ${config.models.enrichment.provider} / ${config.models.enrichment.model} (reasoning: ${config.models.enrichment.reasoning ?? "provider default"})`,
      `Judge:       ${config.models.judge.provider} / ${config.models.judge.model} (reasoning: ${config.models.judge.reasoning ?? "provider default"})`,
      `OpenAI Codex:${openAICodexRoles.length > 0 ? ` configured for ${openAICodexRoles.join(", ")}` : " not configured for language roles"}`,
      "",
      `Ollama:      ${config.providers.ollama.baseUrl} (auto-pull: ${config.providers.ollama.autoPull ? "on" : "off"})`,
      "",
      "Storage:     libSQL",
      `Database:    ${config.storage.libsql.url}`,
      "",
      `CLI Format:  ${config.cli.globalFlags.format}`,
      `Ingest Scope: include ${config.ingest.include.length}, exclude ${config.ingest.exclude.length}`,
      `URL Downloads: max ${config.ingest.urlDownloads.maxFileSize}, timeout ${config.ingest.urlDownloads.timeout}, redirects ${config.ingest.urlDownloads.maxRedirects}`,
      `Visuals:     ${config.ingest.visuals.enabled ? "enabled" : "disabled"}, max image ${config.ingest.visuals.maxImageBytes}, max images/doc ${config.ingest.visuals.maxImagesPerDocument}`,
      "",
      `Server:      ${config.server.host}:${config.server.port}`,
      `Auth:        ${config.server.auth.enabled ? "enabled" : "disabled"}${hasResolvedServerAuthToken ? " (token set)" : ""}`,
      `Auth Env:    ${config.server.auth.tokenEnv}`,
      "",
      hasGatewayKey
        ? "Gateway:     API key configured"
        : "Gateway:     No API key (set via: poink config set providers.gateway.apiKey <key>)",
      hasOpenRouterKey
        ? "OpenRouter:  API key configured"
        : "OpenRouter:  No API key (set via: poink config set providers.openrouter.apiKey <key>)",
      hasGoogleKey
        ? "Google:      API key configured"
        : "Google:      No API key (set via: poink config set providers.google.apiKey <key>)",
      hasAnthropicKey
        ? "Anthropic:  API key configured"
        : "Anthropic:  No API key (set via: poink config set providers.anthropic.apiKey <key>)",
    ]);

    return {
      resultPayload: {
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
      },
      agentResult: { _tag: "config" as const, subcommand: "show" },
    };
  });
}

function runGetConfig(
  path: string | undefined,
  Console: CliConsole,
  config: Config,
  showSecrets: boolean,
) {
  return Effect.gen(function* () {
    if (!path) {
      yield* errorLines(Console, [
        "Error: Path required",
        "Usage: poink config get <path>",
        "Example: poink config get models.embedding.model",
      ]);
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", "Path required", {
          command: "config get",
          hint: "poink config get models.embedding.model",
        }),
      );
    }

    const result = getValueAtPath(config, path);
    if (!result.found) {
      yield* Console.error(`Config path not found: ${path}`);
      return yield* Effect.fail(
        new CLIError("NOT_FOUND", `Config path not found: ${path}`, { path }),
      );
    }

    const outputValue = redactConfigValue(path, result.value, showSecrets);
    yield* Console.log(
      typeof outputValue === "object"
        ? JSON.stringify(outputValue)
        : String(outputValue),
    );
    return {
      resultPayload: { path, value: outputValue },
      agentResult: { _tag: "config" as const, subcommand: "get" },
    };
  });
}

function runSetConfig(
  path: string | undefined,
  newValue: string | undefined,
  Console: CliConsole,
  config: Config,
  showSecrets: boolean,
) {
  return Effect.gen(function* () {
    if (!path || newValue === undefined) {
      yield* errorLines(Console, [
        "Error: Path and value required",
        "Usage: poink config set <path> <value>",
        "Example: poink config set models.embedding.model nomic-embed-text",
      ]);
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

    const parsedValue = parseConfigValue(path, newValue, schemaNode);
    const updatedConfig = cloneConfig(config);
    if (!setValueAtPath(updatedConfig, path, parsedValue)) {
      yield* Console.error(`Invalid config path: ${path}`);
      return yield* Effect.fail(invalidConfigPathError(path));
    }

    const validationResult = yield* Effect.either(
      Effect.try({
        try: () => normalizeConfig(updatedConfig),
        catch: () =>
          new CLIError(
            "INVALID_ARGS",
            `Invalid value for config path: ${path}`,
            { path, value: newValue },
          ),
      }),
    );
    if (validationResult._tag === "Left") {
      yield* Console.error(`Invalid value for config path: ${path}`);
      return yield* Effect.fail(validationResult.left);
    }

    saveConfig(validationResult.right);
    const outputValue = redactConfigValue(path, parsedValue, showSecrets);
    yield* Console.log(`Updated ${path}: ${outputValue}`);
    return {
      resultPayload: { path, value: outputValue },
      agentResult: { _tag: "config" as const, subcommand: "set" },
    };
  });
}

export function runConfigCommand(
  args: string[],
  Console: CliConsole,
  config: Config,
) {
  const { args: configArgs, showSecrets } = parseConfigOutputOptions(
    args.slice(1),
  );
  const subcommand = configArgs[0];

  if (!subcommand || subcommand === "show") {
    return runShowConfig(Console, config, showSecrets);
  }
  if (subcommand === "get") {
    return runGetConfig(configArgs[1], Console, config, showSecrets);
  }
  if (subcommand === "set") {
    return runSetConfig(
      configArgs[1],
      configArgs[2],
      Console,
      config,
      showSecrets,
    );
  }
  if (subcommand === "schema") {
    return Console.log(JSON.stringify(CONFIG_JSON_SCHEMA, null, 2)).pipe(
      Effect.as({
        resultPayload: CONFIG_JSON_SCHEMA,
        agentResult: { _tag: "config" as const, subcommand: "schema" },
      }),
    );
  }

  return Effect.gen(function* () {
    yield* Console.error(`Unknown config subcommand: ${subcommand}`);
    yield* Console.error("Available: show, get, set, schema");
    return yield* Effect.fail(
      new CLIError("INVALID_ARGS", `Unknown config subcommand: ${subcommand}`, {
        subcommand,
        available: ["show", "get", "set", "schema"],
      }),
    );
  });
}
