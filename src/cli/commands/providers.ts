import { Effect } from "effect";
import { runOpenAICodexLogin } from "../../services/OpenAICodexProvider.js";
import { CLIError, describeCliFailure } from "../runner.js";
import type { OutputFormat } from "../../agent/protocol.js";
import type { CliCommandOutput, CliConsole } from "./types.js";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const PROVIDERS_LOGIN_HINT = "poink providers login --provider openai-codex";
const PROVIDERS_LOGIN_TEXT_HINT = `${PROVIDERS_LOGIN_HINT} --format text`;

type ProvidersLoginOptions = {
  provider?: string;
  deviceAuth: boolean;
};

interface ProvidersCommandOptions extends Record<string, unknown> {
  provider?: string;
  deviceAuth?: boolean;
  "device-auth"?: boolean;
  deviceCode?: boolean;
  "device-code"?: boolean;
}

function isEnabled(
  options: ProvidersCommandOptions,
  camelCaseName: keyof ProvidersCommandOptions,
  kebabCaseName: keyof ProvidersCommandOptions,
): boolean {
  return options[camelCaseName] === true || options[kebabCaseName] === true;
}

function validateProvider(provider: string | undefined): void {
  if (provider === OPENAI_CODEX_PROVIDER) return;

  throw new CLIError(
    "INVALID_ARGS",
    "providers login currently supports only --provider openai-codex",
    {
      provider,
      hint: PROVIDERS_LOGIN_HINT,
    },
  );
}

function validateInteractiveFormat(format: OutputFormat): void {
  if (format === "text") return;

  throw new CLIError(
    "INVALID_ARGS",
    "providers login is interactive and requires --format text",
    {
      hint: PROVIDERS_LOGIN_TEXT_HINT,
    },
  );
}

function parseProvidersLoginOptions(
  options: ProvidersCommandOptions,
  format: OutputFormat,
): ProvidersLoginOptions {
  if (isEnabled(options, "deviceCode", "device-code")) {
    throw new CLIError(
      "INVALID_ARGS",
      "Unsupported providers login flag: --device-code",
      {
        flag: "--device-code",
        available: ["--provider openai-codex", "--device-auth"],
      },
    );
  }

  const provider =
    typeof options.provider === "string" ? options.provider : undefined;
  validateProvider(provider);
  validateInteractiveFormat(format);

  return {
    provider,
    deviceAuth: isEnabled(options, "deviceAuth", "device-auth"),
  };
}

function invalidOptionsError(error: unknown): CLIError {
  return error instanceof CLIError
    ? error
    : new CLIError("INVALID_ARGS", describeCliFailure(error));
}

function authenticationError(error: unknown): CLIError {
  return new CLIError("AUTH_FAILED", describeCliFailure(error), {
    cause: error,
  });
}

export function runProvidersCommand(
  args: string[],
  format: OutputFormat,
  Console: CliConsole,
  options: ProvidersCommandOptions = {},
): Effect.Effect<CliCommandOutput, CLIError> {
  return Effect.gen(function* () {
    const subcommand = args[1];
    if (subcommand !== "login") {
      const message = `Unknown providers subcommand: ${subcommand ?? ""}`;
      yield* Console.error(message);
      yield* Console.error("Available: login --provider openai-codex");
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", message, {
          subcommand,
          available: ["login"],
        }),
      );
    }

    const opts = yield* Effect.try({
      try: () => parseProvidersLoginOptions(options, format),
      catch: invalidOptionsError,
    });

    yield* Console.log("Starting OpenAI Codex login...");
    yield* Effect.tryPromise({
      try: () =>
        runOpenAICodexLogin({
          stdio: "inherit",
          deviceAuth: opts.deviceAuth,
        }),
      catch: authenticationError,
    });
    yield* Console.log("OpenAI Codex login complete");

    return {
      resultPayload: {
        provider: OPENAI_CODEX_PROVIDER,
        authenticated: true,
      },
      agentResult: { _tag: "config", subcommand: "providers login" },
    };
  });
}
