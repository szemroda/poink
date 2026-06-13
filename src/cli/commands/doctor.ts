import { Effect } from "effect";
import { existsSync, statSync } from "fs";
import { LibraryConfig, type Document } from "../../types.js";
import { assessDocChunker } from "../../chunking.js";
import {
  assessDoctorHealth,
  assessWALHealth,
  type HealthCheck,
  type WALHealthResult,
} from "../health.js";
import {
  runCommandWithContext,
  type CommandExecutionContext,
  type GlobalCLIOptions,
} from "../runner.js";

type OpenAICodexRole = "enrichment" | "judge";

type OpenAICodexRuntimeStatus = {
  configured: boolean;
  roles: OpenAICodexRole[];
  canStart: boolean;
  authenticated: boolean;
  error?: string;
};

type OrphanedData = {
  chunks: number;
  embeddings: number;
};

type ChunkerHealth = {
  outdated: number;
  missing: number;
  mismatch: number;
  sample: Array<{
    id: string;
    title: string;
    reason: string;
    code: string;
  }>;
};

type DoctorConsole = CommandExecutionContext["Console"];

type DoctorOutcome = {
  checks: HealthCheck[];
  healthy: boolean;
  shouldFix: boolean;
  walHealth: WALHealthResult;
  ollamaReachable: boolean;
  openAICodexCheck: HealthCheck | undefined;
  openAICodexStatus: OpenAICodexRuntimeStatus;
  orphanedData: OrphanedData;
  chunkerOutdated: number;
};

async function checkConfiguredOpenAICodexRuntime(
  config: NonNullable<GlobalCLIOptions["config"]>,
): Promise<OpenAICodexRuntimeStatus> {
  const roles: OpenAICodexRole[] = [];
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

function renderDoctorCheckIcon(check: HealthCheck): string {
  const severity = healthCheckSeverity(check);
  if (severity === "ok") return "OK";
  if (severity === "warning") return "!";
  return "FAIL";
}

function renderDoctorCheckLines(checks: HealthCheck[]): string[] {
  return checks.map((check) => {
    const suffix = check.details ? ` - ${check.details}` : "";
    return `${renderDoctorCheckIcon(check)} ${check.name}${suffix}`;
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

function readWALHealth(walPath: string) {
  if (!existsSync(walPath)) {
    return Effect.succeed<WALHealthResult>({ healthy: true, warnings: [] });
  }

  return Effect.try({
    try: () => statSync(walPath).size,
    catch: () => undefined,
  }).pipe(
    Effect.orElseSucceed(() => 0),
    Effect.map((totalSizeBytes) =>
      assessWALHealth({ fileCount: 1, totalSizeBytes }),
    ),
  );
}

function assessChunkerHealth(
  documents: readonly Document[],
  config: LibraryConfig,
): ChunkerHealth {
  let missing = 0;
  let mismatch = 0;
  const sample: ChunkerHealth["sample"] = [];

  for (const document of documents) {
    const assessment = assessDocChunker(document, config);
    if (!assessment.needsRechunk) continue;

    if (assessment.code === "missing_metadata") {
      missing++;
    } else {
      mismatch++;
    }

    if (sample.length >= 10) continue;
    sample.push({
      id: document.id,
      title: document.title,
      reason: assessment.reason,
      code: assessment.code,
    });
  }

  return {
    outdated: missing + mismatch,
    missing,
    mismatch,
    sample,
  };
}

function logLines(Console: DoctorConsole, lines: readonly string[]) {
  return Effect.forEach(lines, (line) => Console.log(line), {
    discard: true,
  });
}

function logOpenAICodexIssue(
  Console: DoctorConsole,
  status: OpenAICodexRuntimeStatus,
) {
  return Console.log(
    `  OpenAI Codex: ${
      status.error ?? "run poink providers login --provider openai-codex"
    }`,
  );
}

function logUninitializedProviderHealth(
  Console: DoctorConsole,
  check: HealthCheck | undefined,
  status: OpenAICodexRuntimeStatus,
) {
  if (!check) return Effect.void;

  return Effect.gen(function* () {
    yield* Console.log("");
    yield* Console.log("Provider Health Checks:\n");
    yield* logLines(Console, renderDoctorCheckLines([check]));
    if (check.healthy) return;

    yield* Console.log("");
    yield* Console.log("WARN  Issues detected.\n");
    yield* logOpenAICodexIssue(Console, status);
  });
}

function logRepairResults(
  Console: DoctorConsole,
  orphanedData: OrphanedData,
  chunkerOutdated: number,
) {
  return Effect.gen(function* () {
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
  });
}

function logRecommendations(
  Console: DoctorConsole,
  diagnostics: DoctorOutcome,
) {
  return Effect.gen(function* () {
    yield* Console.log("Recommendations:\n");
    if (!diagnostics.walHealth.healthy) {
      yield* Console.log(
        "  WAL: large write-ahead log detected; run a maintenance write or restart processes using the database",
      );
    }
    if (!diagnostics.ollamaReachable) {
      yield* Console.log("  Ollama: Ensure Ollama is running (ollama serve)");
    }
    if (
      diagnostics.openAICodexCheck &&
      !diagnostics.openAICodexCheck.healthy
    ) {
      yield* logOpenAICodexIssue(Console, diagnostics.openAICodexStatus);
    }
    if (
      diagnostics.orphanedData.chunks > 0 ||
      diagnostics.orphanedData.embeddings > 0
    ) {
      yield* Console.log("  Orphaned data: Already cleaned automatically");
    }
    if (diagnostics.chunkerOutdated > 0) {
      yield* Console.log(
        `  Chunker: ${diagnostics.chunkerOutdated} docs missing/outdated chunker metadata`,
      );
      yield* Console.log("          Preview: poink rechunk --dry-run");
      yield* Console.log("          Apply:   poink rechunk");
    }
    yield* Console.log("\n  Run 'poink doctor --fix' to auto-repair issues.");
  });
}

function logDoctorOutcome(
  Console: DoctorConsole,
  diagnostics: DoctorOutcome,
) {
  return Effect.gen(function* () {
    yield* Console.log("Health Check Results:\n");
    yield* logLines(Console, renderDoctorCheckLines(diagnostics.checks));
    yield* Console.log("");

    const hasWarnings = hasDoctorWarnings(diagnostics.checks);
    if (diagnostics.healthy && !hasWarnings) {
      yield* Console.log("OK All checks passed! Database is healthy.");
      return;
    }
    if (diagnostics.healthy) {
      yield* Console.log("OK All checks passed (with warnings).");
      return;
    }

    yield* Console.log("WARN  Issues detected.\n");
    if (diagnostics.shouldFix) {
      yield* logRepairResults(
        Console,
        diagnostics.orphanedData,
        diagnostics.chunkerOutdated,
      );
      return;
    }
    yield* logRecommendations(Console, diagnostics);
  });
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
        yield* logUninitializedProviderHealth(
          Console,
          openAICodexCheck,
          openAICodexStatus,
        );
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

      const walHealth = yield* readWALHealth(walPath);

      const readyResult = yield* Effect.either(library.checkReady());
      const ollamaReachable = readyResult._tag === "Right";

      let orphanedData: OrphanedData = { chunks: 0, embeddings: 0 };
      const repairResult = yield* Effect.either(library.repair());
      if (repairResult._tag === "Right") {
        orphanedData = {
          chunks: repairResult.right.orphanedChunks,
          embeddings: repairResult.right.orphanedEmbeddings,
        };
      }

      const docsResult = yield* Effect.either(library.list());
      const chunker =
        docsResult._tag === "Right"
          ? assessChunkerHealth(docsResult.right, config)
          : assessChunkerHealth([], config);
      const doctorHealth = assessDoctorHealth({
        walHealth,
        ollamaReachable,
        orphanedData,
        chunker,
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
          ...chunker,
          chunkSize: config.chunkSize,
          chunkOverlap: config.chunkOverlap,
          unit: "chars",
        },
        didFix: shouldFix,
      };

      yield* logDoctorOutcome(Console, {
        checks,
        healthy,
        shouldFix,
        walHealth,
        ollamaReachable,
        openAICodexCheck,
        openAICodexStatus,
        orphanedData,
        chunkerOutdated: chunker.outdated,
      });

      return {
        resultPayload,
        agentResult: {
          _tag: "doctor" as const,
          healthy,
          chunkerOutdated: chunker.outdated,
          chunkerMissing: chunker.missing,
          chunkerMismatch: chunker.mismatch,
        },
      };
    }),
    options);
}
