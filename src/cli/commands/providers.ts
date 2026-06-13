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

function parseProvidersLoginOptions(
  options: ProvidersCommandOptions,
  format: OutputFormat,
): ProvidersLoginOptions {
  if (options.deviceCode === true || options["device-code"] === true) {
    throw new CLIError(
      "INVALID_ARGS",
      "Unsupported providers login flag: --device-code",
      {
        flag: "--device-code",
        available: ["--provider openai-codex", "--device-auth"],
      },
    );
  }

  const loginOptions = {
    provider:
      typeof options.provider === "string" ? options.provider : undefined,
    deviceAuth: options.deviceAuth === true || options["device-auth"] === true,
  };

  if (loginOptions.provider !== OPENAI_CODEX_PROVIDER) {
    throw new CLIError(
      "INVALID_ARGS",
      "providers login currently supports only --provider openai-codex",
      {
        provider: loginOptions.provider,
        hint: PROVIDERS_LOGIN_HINT,
      },
    );
  }

  if (format !== "text") {
    throw new CLIError(
      "INVALID_ARGS",
      "providers login is interactive and requires --format text",
      {
        hint: PROVIDERS_LOGIN_TEXT_HINT,
      },
    );
  }

  return loginOptions;
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
      catch: (error) =>
        error instanceof CLIError
          ? error
          : new CLIError("INVALID_ARGS", describeCliFailure(error)),
    });

    yield* Console.log("Starting OpenAI Codex login...");
    yield* Effect.tryPromise({
      try: () =>
        runOpenAICodexLogin({
          stdio: "inherit",
          deviceAuth: opts.deviceAuth,
        }),
      catch: (error) =>
        new CLIError("AUTH_FAILED", describeCliFailure(error), { cause: error }),
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
