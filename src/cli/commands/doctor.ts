import { Effect } from "effect";
import { existsSync, statSync } from "fs";
import { LibraryConfig } from "../../types.js";
import { assessDocChunker } from "../../chunking.js";
import {
  assessDoctorHealth,
  assessWALHealth,
  type HealthCheck,
  type WALHealthResult,
} from "../health.js";
import {
  runCommandWithContext,
  type GlobalCLIOptions,
} from "../runner.js";

type OpenAICodexRuntimeStatus = {
  configured: boolean;
  roles: Array<"enrichment" | "judge">;
  canStart: boolean;
  authenticated: boolean;
  error?: string;
};

async function checkConfiguredOpenAICodexRuntime(
  config: NonNullable<GlobalCLIOptions["config"]>,
): Promise<OpenAICodexRuntimeStatus> {
  const roles: Array<"enrichment" | "judge"> = [];
  if (config.models.enrichment.provider === "openai-codex") {
    roles.push("enrichment");
  }
  if (config.models.judge.provider === "openai-codex") {
    roles.push("judge");
  }
  if (roles.length === 0) {
    return {
      configured: false,
      roles,
      canStart: false,
      authenticated: false,
    };
  }
  const { checkOpenAICodexRuntime } = await import(
    "../../services/OpenAICodexProvider.js"
  );
  return checkOpenAICodexRuntime(config);
}

function healthCheckSeverity(check: HealthCheck): "ok" | "warning" | "error" {
  return check.severity ?? (check.healthy ? "ok" : "error");
}

function hasDoctorWarnings(checks: HealthCheck[]): boolean {
  return checks.some((check) => healthCheckSeverity(check) === "warning");
}

function renderDoctorCheckLines(checks: HealthCheck[]): string[] {
  return checks.map((check) => {
    const severity = healthCheckSeverity(check);
    const icon = severity === "ok" ? "OK" : severity === "warning" ? "!" : "FAIL";
    const suffix = check.details ? ` - ${check.details}` : "";
    return `${icon} ${check.name}${suffix}`;
  });
}

function buildOpenAICodexHealthCheck(
  status: OpenAICodexRuntimeStatus,
): HealthCheck | undefined {
  if (!status.configured) return undefined;
  const healthy = status.canStart && status.authenticated;
  return {
    name: "OpenAI Codex",
    healthy,
    severity: healthy ? "ok" : "error",
    details: [
      `configured for ${status.roles.join(", ")}`,
      "bundled Codex runtime",
      status.error ?? null,
    ]
      .filter(Boolean)
      .join("; "),
  };
}

interface DoctorCommandOptions extends Record<string, unknown> {
  fix?: boolean;
}

export function runDoctorCommand(
  args: string[],
  globals: GlobalCLIOptions,
  options: DoctorCommandOptions = {},
) {
  return runCommandWithContext(args, globals, ({ Console, library, globals }) =>
    Effect.gen(function* () {
      if (args[0] === "check") {
        yield* library.checkReady();
        yield* Console.log("OK Ollama is ready");
        return {
          resultPayload: { reachable: true },
          agentResult: { _tag: "check" as const, reachable: true },
        };
      }

      const opts = options;
      const shouldFix = opts.fix === true;
      const appConfig = globals.config!;
      const config = LibraryConfig.fromConfig(appConfig);
      const openAICodexStatus = yield* Effect.promise(() =>
        checkConfiguredOpenAICodexRuntime(appConfig),
      );
      const openAICodexCheck = buildOpenAICodexHealthCheck(openAICodexStatus);
      const dbPath = config.dbPath;
      const walPath = `${dbPath}-wal`;

      yield* Console.log("Checking database health...\n");

      if (!existsSync(dbPath)) {
        yield* Console.log("OK Library not initialized yet (nothing to check)");
        if (openAICodexCheck) {
          yield* Console.log("");
          yield* Console.log("Provider Health Checks:\n");
          for (const line of renderDoctorCheckLines([openAICodexCheck])) {
            yield* Console.log(line);
          }
          if (!openAICodexCheck.healthy) {
            yield* Console.log("");
            yield* Console.log("WARN  Issues detected.\n");
            yield* Console.log(
              `  OpenAI Codex: ${
                openAICodexStatus.error ??
                "run poink providers login --provider openai-codex"
              }`,
            );
          }
        }
        const healthy = openAICodexCheck ? openAICodexCheck.healthy : true;
        return {
          resultPayload: {
            healthy,
            checks: openAICodexCheck ? [openAICodexCheck] : [],
            dbPath,
            openAICodex: openAICodexStatus,
            didFix: shouldFix,
          },
          agentResult: { _tag: "doctor" as const, healthy },
        };
      }

      let walHealth: WALHealthResult;
      if (existsSync(walPath)) {
        const totalSizeBytes = yield* Effect.try({
          try: () => statSync(walPath).size,
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => 0));
        walHealth = assessWALHealth({ fileCount: 1, totalSizeBytes });
      } else {
        walHealth = { healthy: true, warnings: [] };
      }

      const readyResult = yield* Effect.either(library.checkReady());
      const ollamaReachable = readyResult._tag === "Right";

      let orphanedData = { chunks: 0, embeddings: 0 };
      const repairResult = yield* Effect.either(library.repair());
      if (repairResult._tag === "Right") {
        orphanedData = {
          chunks: repairResult.right.orphanedChunks,
          embeddings: repairResult.right.orphanedEmbeddings,
        };
      }

      let chunkerMissing = 0;
      let chunkerMismatch = 0;
      const chunkerSample: Array<{
        id: string;
        title: string;
        reason: string;
        code: string;
      }> = [];
      const docsResult = yield* Effect.either(library.list());
      if (docsResult._tag === "Right") {
        for (const doc of docsResult.right) {
          const assessment = assessDocChunker(doc, config);
          if (assessment.needsRechunk) {
            if (assessment.code === "missing_metadata") chunkerMissing++;
            else chunkerMismatch++;
            if (chunkerSample.length < 10) {
              chunkerSample.push({
                id: doc.id,
                title: doc.title,
                reason: assessment.reason,
                code: assessment.code,
              });
            }
          }
        }
      }

      const chunkerOutdated = chunkerMissing + chunkerMismatch;
      const doctorHealth = assessDoctorHealth({
        walHealth,
        ollamaReachable,
        orphanedData,
        chunker: { missing: chunkerMissing, mismatch: chunkerMismatch },
      });
      const checks = openAICodexCheck
        ? [...doctorHealth.checks, openAICodexCheck]
        : doctorHealth.checks;
      const healthy = checks.every((check) => check.healthy);

      const resultPayload = {
        healthy,
        checks,
        walHealth,
        ollamaReachable,
        openAICodex: openAICodexStatus,
        orphanedData,
        chunker: {
          outdated: chunkerOutdated,
          missing: chunkerMissing,
          mismatch: chunkerMismatch,
          sample: chunkerSample,
          chunkSize: config.chunkSize,
          chunkOverlap: config.chunkOverlap,
          unit: "chars",
        },
        didFix: shouldFix,
      };

      yield* Console.log("Health Check Results:\n");
      for (const line of renderDoctorCheckLines(checks)) {
        yield* Console.log(line);
      }
      yield* Console.log("");

      const hasWarnings = hasDoctorWarnings(checks);
      if (healthy && !hasWarnings) {
        yield* Console.log("OK All checks passed! Database is healthy.");
      } else if (healthy && hasWarnings) {
        yield* Console.log("OK All checks passed (with warnings).");
      } else {
        yield* Console.log("WARN  Issues detected.\n");

        if (shouldFix) {
          yield* Console.log("Attempting auto-repair...\n");
          if (orphanedData.chunks > 0 || orphanedData.embeddings > 0) {
            yield* Console.log(
              `  OK Cleaned ${orphanedData.chunks} orphaned chunks, ${orphanedData.embeddings} orphaned embeddings`,
            );
          }
          if (chunkerOutdated > 0) {
            yield* Console.log(
              `  WARN Chunker: ${chunkerOutdated} docs missing/outdated chunker metadata (run rechunk separately)`,
            );
          }
          yield* Console.log(
            "\nOK Repair complete. Run 'poink doctor' again to verify.",
          );
        } else {
          yield* Console.log("Recommendations:\n");
          if (!walHealth.healthy) {
            yield* Console.log(
              "  WAL: large write-ahead log detected; run a maintenance write or restart processes using the database",
            );
          }
          if (!ollamaReachable) {
            yield* Console.log("  Ollama: Ensure Ollama is running (ollama serve)");
          }
          if (openAICodexCheck && !openAICodexCheck.healthy) {
            yield* Console.log(
              `  OpenAI Codex: ${
                openAICodexStatus.error ??
                "run poink providers login --provider openai-codex"
              }`,
            );
          }
          if (orphanedData.chunks > 0 || orphanedData.embeddings > 0) {
            yield* Console.log("  Orphaned data: Already cleaned automatically");
          }
          if (chunkerOutdated > 0) {
            yield* Console.log(
              `  Chunker: ${chunkerOutdated} docs missing/outdated chunker metadata`,
            );
            yield* Console.log("          Preview: poink rechunk --dry-run");
            yield* Console.log("          Apply:   poink rechunk");
          }
          yield* Console.log("\n  Run 'poink doctor --fix' to auto-repair issues.");
        }
      }

      return {
        resultPayload,
        agentResult: {
          _tag: "doctor" as const,
          healthy,
          chunkerOutdated,
          chunkerMissing,
          chunkerMismatch,
        },
      };
    }),
    options);
}
