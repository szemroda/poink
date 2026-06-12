import { confirm, input, password, select } from "@inquirer/prompts";
import { Effect, Layer } from "effect";
import { existsSync, readFileSync } from "fs";
import {
  Config,
  LibraryConfig,
  normalizeConfig,
  resolveConfigPath,
  resolveLibraryDbPath,
  resolveLibraryPath,
  saveConfig,
  type EmbeddingProviderName,
  type ProviderName,
} from "../../types.js";
import { runOpenAICodexLogin } from "../../services/OpenAICodexProvider.js";
import {
  CLIError,
  describeCliFailure,
  runCommandWithContext,
  type CliLibrary,
  type GlobalCLIOptions,
} from "../runner.js";
import { initializePoinkLibrary } from "./init.js";
import type { CliCommandOutput } from "./types.js";

const EMBEDDING_PROVIDERS = [
  "ollama",
  "openai",
  "openrouter",
  "google",
  "gateway",
] as const satisfies readonly EmbeddingProviderName[];

const LANGUAGE_PROVIDERS = [
  "ollama",
  "openai-codex",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "gateway",
] as const satisfies readonly ProviderName[];

const API_KEY_PROVIDERS = [
  "openai",
  "openrouter",
  "google",
  "anthropic",
  "gateway",
] as const;

type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];
type SetupMode = "init" | "config";
type CodexAuthAction = "browser" | "device" | "skip";
type ModelDefaultOptions =
  | {
      kind: "embedding";
      currentProvider: EmbeddingProviderName;
      currentModel: string;
      selectedProvider: EmbeddingProviderName;
    }
  | {
      kind: "language";
      currentProvider: ProviderName;
      currentModel: string;
      selectedProvider: ProviderName;
    };

type ConfigChange = {
  path: string;
  before: unknown;
  after: unknown;
  secret?: boolean;
};

type SetupPlan = {
  dryRun: boolean;
  config: Config;
  selectedLibraryPath: string;
  shouldInitialize: boolean;
  changes: ConfigChange[];
  codexAuthAction: CodexAuthAction | null;
};

interface SetupCommandOptions extends Record<string, unknown> {
  dryRun?: boolean;
  "dry-run"?: boolean;
}

function isDryRun(options: SetupCommandOptions): boolean {
  return options.dryRun === true || options["dry-run"] === true;
}

function isApiKeyProvider(provider: ProviderName): provider is ApiKeyProvider {
  return (API_KEY_PROVIDERS as readonly string[]).includes(provider);
}

function isEmbeddingProvider(value: string): value is EmbeddingProviderName {
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

function isLanguageProvider(value: string): value is ProviderName {
  return (LANGUAGE_PROVIDERS as readonly string[]).includes(value);
}

function loadConfigForSetup(): Config {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    return Config.Default;
  }

  return normalizeConfig(JSON.parse(readFileSync(configPath, "utf-8")));
}

function cloneConfig(config: Config): Record<string, any> {
  return JSON.parse(JSON.stringify(config)) as Record<string, any>;
}

function defaultEmbeddingModel(provider: EmbeddingProviderName): string {
  return {
    ollama: "mxbai-embed-large",
    openai: "text-embedding-3-small",
    openrouter: "openai/text-embedding-3-small",
    google: "gemini-embedding-2",
    gateway: "openai/text-embedding-3-small",
  }[provider];
}

function defaultLanguageModel(provider: ProviderName): string {
  return {
    ollama: "llama3.2:3b",
    "openai-codex": "gpt-5.4-mini",
    openai: "gpt-5.4-mini",
    anthropic: "claude-sonnet-4-6",
    google: "gemini-3.5-flash",
    openrouter: "openai/gpt-5.4-mini",
    gateway: "openai/gpt-5.4-mini",
  }[provider];
}

export function selectDefaultModel(options: ModelDefaultOptions): string {
  if (options.currentProvider === options.selectedProvider) {
    return options.currentModel;
  }
  return options.kind === "embedding"
    ? defaultEmbeddingModel(options.selectedProvider)
    : defaultLanguageModel(options.selectedProvider);
}

function getProviderAuth(config: Config, provider: ApiKeyProvider) {
  return config.providers[provider] as {
    apiKey?: string;
    apiKeyEnv?: string;
  };
}

function hasConfiguredAuth(config: Config, provider: ApiKeyProvider): boolean {
  const auth = getProviderAuth(config, provider);
  return Boolean(auth.apiKey || (auth.apiKeyEnv && process.env[auth.apiKeyEnv]));
}

function authStatus(config: Config, provider: ApiKeyProvider): string {
  const auth = getProviderAuth(config, provider);
  if (auth.apiKey) return "API key stored in config";
  if (auth.apiKeyEnv && process.env[auth.apiKeyEnv]) {
    return `environment variable ${auth.apiKeyEnv} detected`;
  }
  if (auth.apiKeyEnv) return `environment variable ${auth.apiKeyEnv} not set`;
  return "not configured";
}

function providerLabel(provider: ProviderName): string {
  return {
    ollama: "Ollama",
    "openai-codex": "OpenAI Codex",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    openrouter: "OpenRouter",
    gateway: "Gateway",
  }[provider];
}

function setPath(target: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }

  const last = parts[parts.length - 1]!;
  if (value === undefined) {
    delete current[last];
  } else {
    current[last] = value;
  }
}

function getPath(source: Record<string, any>, path: string): unknown {
  let current: any = source;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function applyChange(
  target: Record<string, any>,
  path: string,
  value: unknown,
  changes: ConfigChange[],
  secret = false,
): void {
  const before = getPath(target, path);
  if (before === value) return;
  setPath(target, path, value);
  changes.push({ path, before, after: value, secret });
}

function selectedProviderRoles(plan: {
  embeddingProvider: EmbeddingProviderName;
  languageProvider: ProviderName;
}): Map<ProviderName, string[]> {
  const roles = new Map<ProviderName, string[]>();
  roles.set(plan.embeddingProvider, ["embedding"]);
  const existing = roles.get(plan.languageProvider) ?? [];
  roles.set(plan.languageProvider, [...existing, "enrichment", "judge"]);
  return roles;
}

function providerChoices<T extends string>(providers: readonly T[]) {
  return providers.map((provider) => ({
    name: provider,
    value: provider,
  }));
}

async function promptAuthForProvider(
  config: Config,
  target: Record<string, any>,
  provider: ApiKeyProvider,
  roles: string[],
  changes: ConfigChange[],
): Promise<void> {
  const currentStatus = authStatus(config, provider);
  const configured = hasConfiguredAuth(config, provider);
  const choices = [
    ...(configured
      ? [{ name: "Keep current", value: "keep" as const }]
      : []),
    { name: "Use environment variable", value: "env" as const },
    { name: "Store API key in config", value: "config" as const },
    { name: "Skip for now", value: "skip" as const },
  ];

  const method = await select({
    message: `${providerLabel(provider)} authentication (used for ${roles.join(", ")}). Current: ${currentStatus}`,
    choices,
  });

  if (method === "keep" || method === "skip") return;

  const auth = getProviderAuth(config, provider);
  if (method === "env") {
    const envName = await input({
      message: `${providerLabel(provider)} API key environment variable`,
      default: auth.apiKeyEnv,
      validate: (value) =>
        value.trim().length > 0 || "Environment variable name is required",
    });
    const trimmed = envName.trim();
    applyChange(target, `providers.${provider}.apiKeyEnv`, trimmed, changes);
    applyChange(target, `providers.${provider}.apiKey`, undefined, changes, true);
    if (!process.env[trimmed]) {
      console.log(
        `${trimmed} is not set in this shell. Set it before using ${providerLabel(provider)}.`,
      );
    }
    return;
  }

  const key = await password({
    message: `${providerLabel(provider)} API key`,
    mask: "*",
    validate: (value) => value.length > 0 || "API key is required",
  });
  applyChange(target, `providers.${provider}.apiKey`, key, changes, true);
}

async function promptCodexAuth(roles: string[]): Promise<CodexAuthAction> {
  return await select({
    message: `OpenAI Codex authentication (used for ${roles.join(", ")})`,
    choices: [
      { name: "Run browser OAuth after applying config", value: "browser" as const },
      { name: "Run device-code OAuth after applying config", value: "device" as const },
      { name: "Do not run OAuth", value: "skip" as const },
    ],
  });
}

function renderSetupSubcommands(): string {
  return [
    "Usage: poink setup <command>",
    "",
    "Commands:",
    "  init      Initialize Poink and run the configuration wizard",
    "  config    Run the configuration wizard for an initialized library",
  ].join("\n");
}

function textFormatError(format: string): CLIError | null {
  if (format !== "text") {
    return new CLIError(
      "INVALID_ARGS",
      "setup is interactive and requires --format text",
      { hint: "poink setup init --format text" },
    );
  }
  return null;
}

function interactiveTtyError(): CLIError | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return new CLIError(
      "INVALID_ARGS",
      "setup is interactive and requires a terminal",
      { hint: "Run poink setup init from an interactive terminal." },
    );
  }
  return null;
}

function formatValue(value: unknown, secret = false): string {
  if (secret && value !== undefined) return "<set>";
  if (value === undefined) return "<unset>";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function renderSummary(plan: SetupPlan): string {
  const lines = ["Summary"];
  if (plan.dryRun) lines.push("Dry run: no changes will be applied.");

  if (plan.changes.length > 0) {
    lines.push("Config changes:");
    for (const change of plan.changes) {
      lines.push(
        `  ${change.path}: ${formatValue(change.before, change.secret)} -> ${formatValue(change.after, change.secret)}`,
      );
    }
  } else {
    lines.push("No config changes.");
  }

  const actions: string[] = [];
  if (plan.shouldInitialize) {
    actions.push(`Initialize library at ${plan.selectedLibraryPath}`);
  }
  if (plan.codexAuthAction === "browser") {
    actions.push("Run OpenAI Codex OAuth login");
  } else if (plan.codexAuthAction === "device") {
    actions.push("Run OpenAI Codex OAuth login with device code");
  }

  if (actions.length > 0) {
    lines.push("Actions:");
    for (const action of actions) lines.push(`  ${action}`);
  } else {
    lines.push("No side effects.");
  }

  return lines.join("\n");
}

function isNoopPlan(plan: SetupPlan): boolean {
  return (
    plan.changes.length === 0 &&
    !plan.shouldInitialize &&
    (!plan.codexAuthAction || plan.codexAuthAction === "skip")
  );
}

function serializeChanges(changes: ConfigChange[]) {
  return changes.map((change) => ({
    path: change.path,
    before: formatValue(change.before, change.secret),
    after: formatValue(change.after, change.secret),
  }));
}

async function buildSetupPlan(mode: SetupMode, dryRun: boolean): Promise<SetupPlan> {
  const config = loadConfigForSetup();
  const initialLibraryPath = resolveLibraryPath(config);
  const initialDbExists = existsSync(resolveLibraryDbPath(config));

  console.log(mode === "init" ? "Poink setup init" : "Poink setup config");
  console.log(`Library: ${initialLibraryPath}`);
  console.log(`Status: ${initialDbExists ? "initialized" : "not initialized"}`);
  if (dryRun && mode === "config" && !initialDbExists) {
    console.log("Poink is not initialized. This dry run will preview configuration only.");
  }
  console.log("");

  const selectedLibraryPath =
    mode === "init"
      ? (await input({
          message: "Library path",
          default: config.library.path,
          validate: (value) => value.trim().length > 0 || "Library path is required",
        })).trim()
      : config.library.path;

  const target = cloneConfig(config);
  const changes: ConfigChange[] = [];

  if (mode === "init") {
    applyChange(target, "library.path", selectedLibraryPath, changes);
  }

  const visualsEnabled = await confirm({
    message: "Enable visual enrichment?",
    default: config.ingest.visuals.enabled,
  });
  applyChange(target, "ingest.visuals.enabled", visualsEnabled, changes);

  const currentEmbeddingProvider = isEmbeddingProvider(config.models.embedding.provider)
    ? config.models.embedding.provider
    : "ollama";
  const embeddingProvider = await select({
    message: "Embedding provider",
    default: currentEmbeddingProvider,
    choices: providerChoices(EMBEDDING_PROVIDERS),
  });
  applyChange(target, "models.embedding.provider", embeddingProvider, changes);

  const embeddingModel = (await input({
    message: "Embedding model",
    default: selectDefaultModel({
      kind: "embedding",
      currentProvider: config.models.embedding.provider,
      currentModel: config.models.embedding.model,
      selectedProvider: embeddingProvider,
    }),
    validate: (value) => value.trim().length > 0 || "Embedding model is required",
  })).trim();
  applyChange(target, "models.embedding.model", embeddingModel, changes);

  if (visualsEnabled) {
    console.log("Choose an enrichment/judge model that can process images.");
  }

  const currentLanguageProvider = isLanguageProvider(config.models.enrichment.provider)
    ? config.models.enrichment.provider
    : "ollama";
  const languageProvider = await select({
    message: "Enrichment and judge provider",
    default: currentLanguageProvider,
    choices: providerChoices(LANGUAGE_PROVIDERS),
  });
  applyChange(target, "models.enrichment.provider", languageProvider, changes);
  applyChange(target, "models.judge.provider", languageProvider, changes);

  const languageModel = (await input({
    message: "Enrichment and judge model",
    default: selectDefaultModel({
      kind: "language",
      currentProvider: config.models.enrichment.provider,
      currentModel: config.models.enrichment.model,
      selectedProvider: languageProvider,
    }),
    validate: (value) => value.trim().length > 0 || "Language model is required",
  })).trim();
  applyChange(target, "models.enrichment.model", languageModel, changes);
  applyChange(target, "models.judge.model", languageModel, changes);

  const rolesByProvider = selectedProviderRoles({
    embeddingProvider,
    languageProvider,
  });
  let codexAuthAction: CodexAuthAction | null = null;

  for (const [provider, roles] of rolesByProvider) {
    if (provider === "ollama") continue;
    if (provider === "openai-codex") {
      codexAuthAction = await promptCodexAuth(roles);
      continue;
    }
    if (isApiKeyProvider(provider)) {
      await promptAuthForProvider(config, target, provider, roles, changes);
    }
  }

  const selectedConfig = normalizeConfig(target);
  const selectedDbExists = existsSync(resolveLibraryDbPath(selectedConfig));

  return {
    dryRun,
    config: selectedConfig,
    selectedLibraryPath: resolveLibraryPath(selectedConfig),
    shouldInitialize: mode === "init" && !selectedDbExists,
    changes,
    codexAuthAction,
  };
}

async function runSetupWizard(mode: SetupMode, dryRun: boolean): Promise<SetupPlan | null> {
  try {
    const plan = await buildSetupPlan(mode, dryRun);
    console.log("");
    console.log(renderSummary(plan));
    if (isNoopPlan(plan)) {
      console.log("Nothing to apply.");
      return null;
    }

    const apply = await confirm({
      message: dryRun ? "Finish dry run?" : "Apply these changes?",
      default: true,
    });
    if (!apply) {
      console.log("No changes applied.");
      return null;
    }
    return plan;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "ExitPromptError" || /User force closed/.test(error.message))
    ) {
      throw new CLIError("CANCELLED", "Setup cancelled");
    }
    throw error;
  }
}

async function runCodexAuth(action: CodexAuthAction | null): Promise<void> {
  if (!action || action === "skip") return;
  await runOpenAICodexLogin({
    stdio: "inherit",
    deviceAuth: action === "device",
  });
}

export function runSetupCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: SetupCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, format }) =>
    Effect.gen(function* (): Generator<any, CliCommandOutput, any> {
      const subcommand = args[1];
      const dryRun = isDryRun(options);

      if (!subcommand) {
        yield* Console.log(renderSetupSubcommands());
        return {
          resultPayload: {
            commands: ["init", "config"],
          },
          agentResult: null,
        };
      }

      if (subcommand !== "init" && subcommand !== "config") {
        yield* Console.error(`Unknown setup subcommand: ${subcommand}`);
        yield* Console.error("Available: init, config");
        return yield* Effect.fail(
          new CLIError("INVALID_ARGS", `Unknown setup subcommand: ${subcommand}`, {
            subcommand,
            available: ["init", "config"],
          }),
        );
      }

      const formatError = textFormatError(format);
      if (formatError) {
        return yield* Effect.fail(formatError);
      }

      const currentConfig = loadConfigForSetup();
      const currentDbPath = resolveLibraryDbPath(currentConfig);
      const currentDbExists = existsSync(currentDbPath);

      if (subcommand === "config" && !dryRun && !currentDbExists) {
        return yield* Effect.fail(
          new CLIError(
            "NOT_INITIALIZED",
            "Poink is not initialized yet. Run: poink setup init",
            { hint: "poink setup init" },
          ),
        );
      }

      const ttyError = interactiveTtyError();
      if (ttyError) {
        return yield* Effect.fail(ttyError);
      }

      const plan = yield* Effect.tryPromise({
        try: () => runSetupWizard(subcommand, dryRun),
        catch: (error) =>
          new CLIError("SETUP_FAILED", describeCliFailure(error), { cause: error }),
      });

      if (!plan) {
        return {
          resultPayload: { applied: false },
          agentResult: { _tag: "config", subcommand: `setup ${subcommand}` },
        };
      }

      if (dryRun) {
        yield* Console.log("Dry run complete. No changes applied.");
        return {
          resultPayload: {
            applied: false,
            dryRun: true,
            changes: serializeChanges(plan.changes),
            wouldInitialize: plan.shouldInitialize,
            codexAuthAction: plan.codexAuthAction,
          },
          agentResult: { _tag: "config", subcommand: `setup ${subcommand}` },
        };
      }

      saveConfig(plan.config);
      if (plan.shouldInitialize) {
        yield* Effect.gen(function* () {
          const [
            { buildDiagnosticsLayer },
            { LibraryStore },
            { EmbeddingProvider },
          ] = yield* Effect.promise(() =>
            Promise.all([
              import("../runtime.js"),
              import("../../services/LibraryStore.js"),
              import("../../services/EmbeddingProvider.js"),
            ]),
          );
          const layer = yield* Effect.promise(() =>
            buildDiagnosticsLayer(plan.config),
          );
          const initialize = Effect.gen(function* () {
            const store = yield* LibraryStore;
            const embedding = yield* EmbeddingProvider;
            return yield* initializePoinkLibrary(
              Console,
              {
                ...store,
                checkReady: () => embedding.checkHealth(),
              } as CliLibrary,
              new LibraryConfig({
                libraryPath: plan.selectedLibraryPath,
                dbPath: resolveLibraryDbPath(plan.config),
                chunkSize: plan.config.chunking.size,
                chunkOverlap: plan.config.chunking.overlap,
              }),
            );
          });
          yield* initialize.pipe(
            Effect.provide(
              layer as unknown as Layer.Layer<unknown, unknown, never>,
            ),
            Effect.scoped,
          ) as Effect.Effect<unknown, unknown, never>;
        });
      }
      yield* Effect.tryPromise({
        try: () => runCodexAuth(plan.codexAuthAction),
        catch: (error) =>
          new CLIError("AUTH_FAILED", describeCliFailure(error), { cause: error }),
      });

      yield* Console.log("Setup complete.");
      return {
        resultPayload: {
          applied: true,
          changes: serializeChanges(plan.changes),
          initialized: plan.shouldInitialize,
          codexAuthAction: plan.codexAuthAction,
        },
        agentResult: { _tag: "config", subcommand: `setup ${subcommand}` },
      };
    }),
    options,
  );
}
