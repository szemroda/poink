import { resolve } from "node:path";

import { expandHomePath } from "./types.js";

const PATH_SEPARATOR_RE = /[\\/]+/g;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_RE = /^\\\\/;

function isWindowsStylePath(path: string): boolean {
  return (
    path.includes("\\") ||
    WINDOWS_DRIVE_RE.test(path) ||
    WINDOWS_UNC_RE.test(path)
  );
}

function normalizeSegmentPath(path: string): string {
  return path.replace(PATH_SEPARATOR_RE, "/").replace(/\/+$/g, "");
}

function stripBasePath(filePath: string, basePath?: string): string {
  if (!basePath) return normalizeSegmentPath(filePath);

  const normalizedFile = normalizeSegmentPath(filePath);
  const normalizedBase = normalizeSegmentPath(basePath);
  const caseInsensitive =
    isWindowsStylePath(filePath) || isWindowsStylePath(basePath);
  const fileForCompare = caseInsensitive
    ? normalizedFile.toLowerCase()
    : normalizedFile;
  const baseForCompare = caseInsensitive
    ? normalizedBase.toLowerCase()
    : normalizedBase;

  if (fileForCompare === baseForCompare) return "";
  if (fileForCompare.startsWith(`${baseForCompare}/`)) {
    return normalizedFile.slice(normalizedBase.length + 1);
  }

  return normalizedFile;
}

export function resolveUserPath(
  inputPath: string,
  cwd: string = process.cwd()
): string {
  const expandedPath = expandHomePath(inputPath);
  return resolve(cwd, expandedPath);
}

export function getPathFilename(filePath: string): string {
  const trimmedPath = filePath.replace(/[\\/]+$/g, "");
  if (!trimmedPath) return "";

  const segments = trimmedPath.split(PATH_SEPARATOR_RE).filter(Boolean);
  return segments.at(-1) ?? "";
}

export function getPathSegments(
  filePath: string,
  basePath?: string
): string[] {
  const relativePath = stripBasePath(filePath, basePath);
  if (!relativePath) return [];
  return relativePath.split("/").filter(Boolean);
}
