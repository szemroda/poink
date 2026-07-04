import { readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import picomatch from "picomatch";
import { fileTypeFromExtension } from "../urlDownloads.js";

export type IngestSelectionFilters = {
  include: string[];
  exclude: string[];
};

export type IngestSelectionSummary = IngestSelectionFilters & {
  discovered: number;
  included: number;
  excluded: number;
  selected: number;
  sampled: number;
};

export type IngestDiscoveryResult = {
  files: string[];
  selection: IngestSelectionSummary;
  discoveredFiles: string[];
  includedFiles: string[];
  excludedFiles: string[];
};

type DiscoveryCandidate = {
  absolutePath: string;
  relativePath: string;
};

type DiscoveryFileSets = {
  files: string[];
  discoveredFiles: string[];
  includedFiles: string[];
  excludedFiles: string[];
};

type Matcher = (input: string) => boolean;

type SelectionCounts = {
  discovered: number;
  included: number;
  excluded: number;
  selected: number;
  sampled: number;
};

const MATCH_OPTIONS = {
  dot: true,
};

export function normalizeGlobPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function globPatternsFromOption(value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") return [value];
  return [];
}

function createMatcher(patterns: string[]): Matcher | undefined {
  if (patterns.length === 0) return undefined;
  return picomatch(patterns, MATCH_OPTIONS);
}

function isDiscoveryCandidate(filename: string): boolean {
  const extension = extname(filename).toLowerCase();
  return extension === "" || fileTypeFromExtension(extension) !== null;
}

function discoverCandidates(
  root: string,
  directory: string,
  recursive: boolean,
): DiscoveryCandidate[] {
  const candidates: DiscoveryCandidate[] = [];

  try {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          if (recursive) {
            candidates.push(...discoverCandidates(root, fullPath, recursive));
          }
          continue;
        }
        if (stat.isFile() && isDiscoveryCandidate(entry)) {
          candidates.push({
            absolutePath: fullPath,
            relativePath: normalizeGlobPath(relative(root, fullPath)),
          });
        }
      } catch {
        // Skip entries we cannot access.
      }
    }
  } catch {
    // Skip directories we cannot read.
  }

  return candidates;
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function createSelectionSummary(
  filters: IngestSelectionFilters,
  counts: SelectionCounts,
): IngestSelectionSummary {
  return {
    include: [...filters.include],
    exclude: [...filters.exclude],
    ...counts,
  };
}

function pathsFromCandidates(candidates: DiscoveryCandidate[]): string[] {
  return dedupePaths(candidates.map((candidate) => candidate.absolutePath));
}

function createDiscoveryResult(
  filters: IngestSelectionFilters,
  fileSets: DiscoveryFileSets,
): IngestDiscoveryResult {
  const { files, discoveredFiles, includedFiles } = fileSets;
  const { excludedFiles } = fileSets;
  return {
    files,
    discoveredFiles,
    includedFiles,
    excludedFiles,
    selection: createSelectionSummary(filters, {
      discovered: discoveredFiles.length,
      included: includedFiles.length,
      excluded: excludedFiles.length,
      selected: files.length,
      sampled: files.length,
    }),
  };
}

export function discoverIngestFiles(
  root: string,
  filters: IngestSelectionFilters,
  recursive: boolean,
): IngestDiscoveryResult {
  const candidates = discoverCandidates(root, root, recursive);
  const includeMatcher = createMatcher(filters.include);
  const excludeMatcher = createMatcher(filters.exclude);

  const includedCandidates = includeMatcher
    ? candidates.filter((candidate) => includeMatcher(candidate.relativePath))
    : candidates;
  const selectedCandidates = excludeMatcher
    ? includedCandidates.filter(
        (candidate) => !excludeMatcher(candidate.relativePath),
      )
    : includedCandidates;
  const excludedCandidates = excludeMatcher
    ? includedCandidates.filter((candidate) =>
        excludeMatcher(candidate.relativePath),
      )
    : [];

  return createDiscoveryResult(filters, {
    files: pathsFromCandidates(selectedCandidates),
    discoveredFiles: pathsFromCandidates(candidates),
    includedFiles: pathsFromCandidates(includedCandidates),
    excludedFiles: pathsFromCandidates(excludedCandidates),
  });
}

export function combineIngestDiscoveryResults(
  results: IngestDiscoveryResult[],
  filters: IngestSelectionFilters,
): IngestDiscoveryResult {
  const discoveredFiles = dedupePaths(
    results.flatMap((result) => result.discoveredFiles),
  );
  const includedFiles = dedupePaths(
    results.flatMap((result) => result.includedFiles),
  );
  const excludedFiles = dedupePaths(
    results.flatMap((result) => result.excludedFiles),
  );
  const excludedPaths = new Set(excludedFiles);
  const files = dedupePaths(results.flatMap((result) => result.files)).filter(
    (file) => !excludedPaths.has(file),
  );

  return createDiscoveryResult(filters, {
    files,
    discoveredFiles,
    includedFiles,
    excludedFiles,
  });
}

export function withSampledSelection(
  selection: IngestSelectionSummary,
  sampled: number,
): IngestSelectionSummary {
  return {
    ...selection,
    sampled,
  };
}
