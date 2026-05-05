import { rmSync } from "fs";

export async function removeDirWithRetries(
  path: string,
  attempts = 40,
  delayMs = 50,
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
        await Bun.sleep(delayMs);
      }
    }
  }

  throw new Error(
    `Failed to remove temp dir after ${attempts} attempts: ${path}. ` +
      `Last error: ${lastError?.message ?? "unknown"}`,
  );
}
