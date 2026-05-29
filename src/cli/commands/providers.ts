import { Effect } from "effect";
import { runOpenAICodexLogin } from "../../services/OpenAICodexProvider.js";
import { CLIError } from "../runner.js";
import type { OutputFormat } from "../../agent/protocol.js";
import type { CliCommandOutput, CliConsole } from "./types.js";

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

function providersLoginOptions(options: ProvidersCommandOptions): ProvidersLoginOptions {
  if (options.deviceCode === true || options["device-code"] === true) {
    throw new CLIError("INVALID_ARGS", "Unsupported providers login flag: --device-code", {
      flag: "--device-code",
      available: ["--provider openai-codex", "--device-auth"],
    });
  }
  return {
    provider: typeof options.provider === "string" ? options.provider : undefined,
    deviceAuth: options.deviceAuth === true || options["device-auth"] === true,
  };
}

export function runProvidersCommand(
  args: string[],
  format: OutputFormat,
  Console: CliConsole,
  options: ProvidersCommandOptions = {},
) {
  return Effect.gen(function* (): Generator<any, CliCommandOutput, any> {
    const subcommand = args[1];
    if (subcommand !== "login") {
      yield* Console.error(`Unknown providers subcommand: ${subcommand ?? ""}`);
      yield* Console.error("Available: login --provider openai-codex");
      return yield* Effect.fail(
        new CLIError(
          "INVALID_ARGS",
          `Unknown providers subcommand: ${subcommand ?? ""}`,
          {
            subcommand,
            available: ["login"],
          },
        ),
      );
    }

    let opts: ProvidersLoginOptions;
    try {
      opts = providersLoginOptions(options);
    } catch (error) {
      if (error instanceof CLIError) {
        return yield* Effect.fail(error);
      }
      throw error;
    }

    if (opts.provider !== "openai-codex") {
      return yield* Effect.fail(
        new CLIError(
          "INVALID_ARGS",
          "providers login currently supports only --provider openai-codex",
          {
      provider: opts.provider,
            hint: "poink providers login --provider openai-codex",
          },
        ),
      );
    }

    if (format !== "text") {
      return yield* Effect.fail(
        new CLIError(
          "INVALID_ARGS",
          "providers login is interactive and requires --format text",
          {
            hint: "poink providers login --provider openai-codex --format text",
          },
        ),
      );
    }

    yield* Console.log("Starting OpenAI Codex login...");
    yield* Effect.tryPromise({
      try: () =>
        runOpenAICodexLogin({
          stdio: "inherit",
          deviceAuth: opts.deviceAuth,
        }),
      catch: (error) => error,
    });
    yield* Console.log("OpenAI Codex login complete");

    return {
      resultPayload: {
        provider: "openai-codex",
        authenticated: true,
      },
      agentResult: { _tag: "config", subcommand: "providers login" },
    };
  });
}
