import { Effect } from "effect";
import { accessSync, constants, statSync } from "node:fs";
import type { OutputFormat } from "../../agent/protocol.js";
import { resolveUserPath } from "../../pathUtils.js";
import { CLIError, type CliLibrary } from "../runner.js";
import type { CliCommandOutput, CliConsole } from "./types.js";

type DocRelocateLibrary = Pick<CliLibrary, "relocate">;

type DocRelocateResult = {
  docId: string;
  title: string;
  oldPath: string;
  newPath: string;
  changed: boolean;
  dryRun?: true;
};

function booleanOption(
  options: Record<string, unknown>,
  camelCase: string,
  kebabCase: string,
): boolean {
  return options[camelCase] === true || options[kebabCase] === true;
}

function requireReadableFile(path: string): void {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    throw new CLIError(
      "NEW_PATH_NOT_FOUND",
      `New path does not exist: ${path}`,
      { path },
    );
  }

  if (!stats.isFile()) {
    throw new CLIError(
      "NEW_PATH_NOT_FILE",
      `New path is not a file: ${path}`,
      { path },
    );
  }

  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new CLIError(
      "NEW_PATH_UNREADABLE",
      `New path is not readable: ${path}`,
      { path },
    );
  }
}

function isTaggedError(error: unknown, tag: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === tag
  );
}

function toDocRelocateError(error: unknown, docId: string): unknown {
  if (!isTaggedError(error, "DocumentNotFoundError")) return error;
  return new CLIError("NOT_FOUND", `Document not found: ${docId}`, { docId });
}

function withDryRunFlag(
  result: Omit<DocRelocateResult, "dryRun">,
  dryRun: boolean,
): DocRelocateResult {
  return dryRun ? { ...result, dryRun: true } : result;
}

export function runDocRelocateCommand(
  args: string[],
  format: OutputFormat,
  library: DocRelocateLibrary,
  Console: CliConsole,
  options: Record<string, unknown>,
): Effect.Effect<CliCommandOutput<DocRelocateResult>, unknown, never> {
  return Effect.gen(function* () {
    const docId = args[2];
    const rawNewPath = args[3];
    if (!docId || !rawNewPath) {
      yield* Console.error(
        "Usage: poink doc relocate <docId> <new-path> [--dry-run]",
      );
      return yield* Effect.fail(
        new CLIError("INVALID_ARGS", "docId and new path required", {
          command: "doc relocate",
        }),
      );
    }

    const newPath = resolveUserPath(rawNewPath);
    yield* Effect.try({
      try: () => requireReadableFile(newPath),
      catch: (error) =>
        error instanceof CLIError
          ? error
          : new CLIError(
              "NEW_PATH_UNREADABLE",
              `New path is not readable: ${newPath}`,
            ),
    });

    const dryRun = booleanOption(options, "dryRun", "dry-run");
    const result = yield* library.relocate(docId, newPath, { dryRun }).pipe(
      Effect.mapError((error) => toDocRelocateError(error, docId)),
    );
    const resultPayload = withDryRunFlag(result, dryRun);

    if (format === "text") {
      yield* Console.log(
        dryRun ? "Would relocate document" : "Relocated document",
      );
      yield* Console.log(`ID: ${result.docId}`);
      yield* Console.log(`Title: ${result.title}`);
      yield* Console.log(`Old path: ${result.oldPath}`);
      yield* Console.log(`New path: ${result.newPath}`);
    }

    return { command: "doc relocate", resultPayload, agentResult: null };
  });
}
