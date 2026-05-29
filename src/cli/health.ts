export interface WALHealthResult {
  healthy: boolean;
  warnings: string[];
}

export interface HealthCheck {
  name: string;
  healthy: boolean;
  severity?: "ok" | "warning" | "error";
  details?: string;
}

export interface DoctorHealthResult {
  healthy: boolean;
  checks: HealthCheck[];
}

export function assessWALHealth(stats: {
  fileCount: number;
  totalSizeBytes: number;
}): WALHealthResult {
  const warnings: string[] = [];
  const fileCountThreshold = 50;
  const sizeThresholdMB = 50;
  const sizeThresholdBytes = sizeThresholdMB * 1024 * 1024;

  if (stats.fileCount > fileCountThreshold) {
    warnings.push(
      `WAL file count (${stats.fileCount}) exceeds recommended threshold (${fileCountThreshold})`,
    );
  }

  const sizeMB = stats.totalSizeBytes / (1024 * 1024);
  if (stats.totalSizeBytes > sizeThresholdBytes) {
    warnings.push(
      `WAL size (${sizeMB.toFixed(1)} MB) exceeds recommended threshold (${sizeThresholdMB} MB)`,
    );
  }

  return {
    healthy: warnings.length === 0,
    warnings,
  };
}

export function assessDoctorHealth(data: {
  walHealth: WALHealthResult;
  ollamaReachable: boolean;
  orphanedData: { chunks: number; embeddings: number };
  chunker: { missing: number; mismatch: number };
}): DoctorHealthResult {
  const checks: HealthCheck[] = [];

  checks.push({
    name: "WAL Files",
    healthy: data.walHealth.healthy,
    severity: data.walHealth.healthy ? "ok" : "error",
    details:
      data.walHealth.warnings.length > 0
        ? data.walHealth.warnings.join("; ")
        : undefined,
  });

  checks.push({
    name: "Ollama",
    healthy: data.ollamaReachable,
    severity: data.ollamaReachable ? "ok" : "error",
    details: data.ollamaReachable ? undefined : "Unreachable",
  });

  const hasOrphans =
    data.orphanedData.chunks > 0 || data.orphanedData.embeddings > 0;
  checks.push({
    name: "Orphaned Data",
    healthy: !hasOrphans,
    severity: !hasOrphans ? "ok" : "error",
    details: hasOrphans
      ? `${data.orphanedData.chunks} chunks, ${data.orphanedData.embeddings} embeddings`
      : undefined,
  });

  const hasMismatch = data.chunker.mismatch > 0;
  const hasMissing = data.chunker.missing > 0;
  checks.push({
    name: "Chunker Metadata",
    healthy: !hasMismatch,
    severity: hasMismatch ? "error" : hasMissing ? "warning" : "ok",
    details:
      hasMismatch || hasMissing
        ? [
            hasMismatch
              ? `${data.chunker.mismatch} document(s) have mismatched chunker metadata`
              : null,
            hasMissing
              ? `${data.chunker.missing} document(s) are missing chunker metadata (unknown; consider rechunking)`
              : null,
          ]
            .filter(Boolean)
            .join("; ")
        : undefined,
  });

  return {
    healthy: checks.every((check) => check.healthy),
    checks,
  };
}
