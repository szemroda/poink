import { rmSync } from "fs";

type EnvSnapshot = Record<string, string | undefined>;

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[name];
      continue;
    }

    process.env[name] = value;
  }
}

export function snapshotEnv(names: readonly string[]): EnvSnapshot {
  return Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
}

export function restoreEnvSnapshot(snapshot: EnvSnapshot): void {
  restoreEnv(snapshot);
}

export function withEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => T,
): T {
  const snapshot = snapshotEnv(Object.keys(updates));

  for (const [name, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[name];
      continue;
    }

    process.env[name] = value;
  }

  try {
    return run();
  } finally {
    restoreEnv(snapshot);
  }
}

export async function removeDirWithRetries(
  path: string,
  attempts = 300,
  delayMs = 100,
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error)) throw error;

      const code = "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "ENOENT") return;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }

  throw new Error(
    `Failed to remove temp dir after ${attempts} attempts: ${path}. ` +
      `Last error: ${lastError?.message ?? "unknown"}`,
  );
}
