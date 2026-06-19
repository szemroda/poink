import { Effect } from "effect";
import type { OutputFormat } from "../../agent/protocol.js";
import type { Document } from "../../types.js";
import { CLIError, type CliLibrary } from "../runner.js";
import type { CliCommandOutput, CliConsole } from "./types.js";
import { runPageExtractCommand } from "./pageExtract.js";

export type DocumentSummary = Pick<
  Document,
  "id" | "title" | "pageCount" | "tags" | "fileType"
>;

type LibraryCommandContext = {
  args: string[];
  command: string;
  format: OutputFormat;
  library: CliLibrary;
  Console: CliConsole;
  verbose: boolean;
  options: Record<string, unknown>;
};

type LibraryCommandHandler = (
  context: LibraryCommandContext,
) => Effect.Effect<CliCommandOutput, unknown, unknown>;

export function toDocumentSummary(doc: Document): DocumentSummary {
  return {
    id: doc.id,
    title: doc.title,
    pageCount: doc.pageCount,
    tags: [...doc.tags],
    fileType: doc.fileType,
  };
}

function optionValue(args: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === name) return args[index + 1];
    if (arg.startsWith(equalsPrefix)) return arg.slice(equalsPrefix.length);
  }
  return undefined;
}

function failWithMessage(
  Console: CliConsole,
  consoleMessage: string,
  error: CLIError,
) {
  return Effect.gen(function* () {
    yield* Console.error(consoleMessage);
    return yield* Effect.fail(error);
  });
}

const runChunkCommand: LibraryCommandHandler = ({
  args,
  format,
  library,
  Console,
}) =>
  Effect.gen(function* () {
    const subcommand = args[1];
    if (subcommand !== "get") {
      return yield* failWithMessage(
        Console,
        "Usage: poink chunk get <chunkId>",
        new CLIError("INVALID_ARGS", "Unknown chunk subcommand", {
          subcommand,
          hint: "poink chunk get <chunkId>",
        }),
      );
    }

    const chunkId = args[2];
    if (!chunkId) {
      return yield* failWithMessage(
        Console,
        "Error: chunkId required",
        new CLIError("INVALID_ARGS", "chunkId required", {
          command: "chunk get",
        }),
      );
    }

    const chunk = yield* library.getChunk(chunkId);
    if (!chunk) {
      return yield* failWithMessage(
        Console,
        `Chunk not found: ${chunkId}`,
        new CLIError("NOT_FOUND", `Chunk not found: ${chunkId}`, { chunkId }),
      );
    }

    if (format === "text") {
      yield* Console.log(chunk.content);
    }
    return { resultPayload: chunk, agentResult: null };
  });

function pageOptionValue(
  args: string[],
  options: Record<string, unknown>,
): string | undefined {
  if (typeof options.page === "number" || typeof options.page === "string") {
    return String(options.page);
  }
  return optionValue(args.slice(3), "--page");
}

const runDocumentCommand: LibraryCommandHandler = ({
  args,
  format,
  library,
  Console,
  options,
}) =>
  Effect.gen(function* () {
    const subcommand = args[1];
    if (subcommand !== "chunks") {
      return yield* failWithMessage(
        Console,
        "Usage: poink doc chunks <docId> [--page N]",
        new CLIError("INVALID_ARGS", "Unknown doc subcommand", {
          subcommand,
          hint: "poink doc chunks <docId> [--page N]",
        }),
      );
    }

    const docId = args[2];
    if (!docId) {
      return yield* failWithMessage(
        Console,
        "Error: docId required",
        new CLIError("INVALID_ARGS", "docId required", {
          command: "doc chunks",
        }),
      );
    }

    const pageValue = pageOptionValue(args, options);
    const page = pageValue ? Number(pageValue) : undefined;
    if (page !== undefined && (Number.isNaN(page) || page <= 0)) {
      return yield* failWithMessage(
        Console,
        "Error: --page must be a positive number",
        new CLIError("INVALID_ARGS", "--page must be a positive number", {
          page: pageValue,
        }),
      );
    }

    const chunks = yield* library.listChunksByDocument(docId, { page });
    const resultPayload = {
      docId,
      page: page ?? null,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        docId: chunk.docId,
        page: chunk.page,
        chunkIndex: chunk.chunkIndex,
      })),
    };

    if (format === "text") {
      for (const chunk of chunks) {
        yield* Console.log(
          `${chunk.id}\tpage=${chunk.page}\tchunkIndex=${chunk.chunkIndex}`,
        );
      }
    }
    return { resultPayload, agentResult: null };
  });

const runPageCommand: LibraryCommandHandler = ({
  args,
  format,
  library,
  Console,
  options,
}) =>
  Effect.gen(function* () {
    const subcommand = args[1];
    if (subcommand === "extract") {
      return yield* runPageExtractCommand(
        args,
        format,
        library,
        Console,
        options,
      );
    }
    if (subcommand !== "get") {
      return yield* failWithMessage(
        Console,
        "Usage: poink page get <docId> <page> | poink page extract <docId> <pages>",
        new CLIError("INVALID_ARGS", "Unknown page subcommand", {
          subcommand,
          hint: "poink page extract <docId> <pages>",
        }),
      );
    }

    const docId = args[2];
    const page = args[3] ? Number(args[3]) : NaN;
    if (!docId || Number.isNaN(page) || page <= 0) {
      return yield* failWithMessage(
        Console,
        "Error: docId and page required",
        new CLIError("INVALID_ARGS", "docId and page required", {
          docId,
          page: args[3],
        }),
      );
    }

    const chunks = yield* library.listChunksByDocument(docId, { page });
    const sortedChunks = [...chunks].sort(
      (left, right) => left.chunkIndex - right.chunkIndex,
    );
    const content = sortedChunks.map((chunk) => chunk.content).join("\n\n");
    const resultPayload = {
      docId,
      page,
      chunkCount: sortedChunks.length,
      chunkIds: sortedChunks.map((chunk) => chunk.id),
      content,
    };

    if (format === "text") {
      yield* Console.log(content);
    }
    return { resultPayload, agentResult: null };
  });

function tagOptionValue(
  args: string[],
  options: Record<string, unknown>,
): string | undefined {
  return typeof options.tag === "string"
    ? options.tag
    : optionValue(args.slice(1), "--tag");
}

const runListCommand: LibraryCommandHandler = ({
  args,
  library,
  Console,
  verbose,
  options,
}) =>
  Effect.gen(function* () {
    const tag = tagOptionValue(args, options);
    const docs = yield* library.list(tag);
    const resultPayload = verbose
      ? { tag: tag ?? null, documents: docs }
      : { documents: docs.map(toDocumentSummary) };

    if (docs.length === 0) {
      yield* Console.log(tag ? `No documents with tag "${tag}"` : "Library is empty");
    } else {
      yield* Console.log(`Documents: ${docs.length}\n`);
      for (const doc of docs) {
        const tags = doc.tags.length ? ` [${doc.tags.join(", ")}]` : "";
        yield* Console.log(`- ${doc.title} (${doc.pageCount} pages)${tags}`);
        yield* Console.log(`  ID: ${doc.id}`);
      }
    }

    return {
      resultPayload,
      agentResult: {
        _tag: "list",
        count: docs.length,
        tag,
        firstDoc:
          docs.length > 0
            ? { title: docs[0]!.title, id: docs[0]!.id }
            : undefined,
      },
    };
  });

const runReadCommand: LibraryCommandHandler = ({
  args,
  command,
  format,
  library,
  Console,
}) =>
  Effect.gen(function* () {
    const id = args[1];
    if (!id) {
      return yield* failWithMessage(
        Console,
        "Error: ID or title required",
        new CLIError("INVALID_ARGS", "ID or title required", { command }),
      );
    }

    const doc = yield* library.get(id);
    if (!doc) {
      return yield* failWithMessage(
        Console,
        `Not found: ${id}`,
        new CLIError("NOT_FOUND", `Not found: ${id}`, { idOrTitle: id }),
      );
    }

    if (format === "text") {
      yield* Console.log(`Title: ${doc.title}`);
      yield* Console.log(`ID: ${doc.id}`);
      yield* Console.log(`Path: ${doc.path}`);
      yield* Console.log(`Pages: ${doc.pageCount}`);
      yield* Console.log(`Size: ${(doc.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
      yield* Console.log(`Added: ${doc.addedAt}`);
      yield* Console.log(`Tags: ${doc.tags.length ? doc.tags.join(", ") : "(none)"}`);
    }

    return {
      resultPayload: doc,
      agentResult: {
        _tag: "read",
        title: doc.title,
        id: doc.id,
        tags: [...doc.tags],
      },
    };
  });

const runRemoveCommand: LibraryCommandHandler = ({ args, library, Console }) =>
  Effect.gen(function* () {
    const id = args[1];
    if (!id) {
      return yield* failWithMessage(
        Console,
        "Error: ID or title required",
        new CLIError("INVALID_ARGS", "ID or title required", {
          command: "remove",
        }),
      );
    }

    const doc = yield* library.remove(id);
    yield* Console.log(`OK Removed: ${doc.title}`);
    return {
      resultPayload: doc,
      agentResult: { _tag: "remove", title: doc.title },
    };
  });

const runTagCommand: LibraryCommandHandler = ({ args, library, Console }) =>
  Effect.gen(function* () {
    const id = args[1];
    const tags = args[2];
    if (!id || !tags) {
      return yield* failWithMessage(
        Console,
        "Error: ID and tags required",
        new CLIError("INVALID_ARGS", "ID and tags required", {
          command: "tag",
        }),
      );
    }

    const tagList = tags.split(",").map((tag) => tag.trim());
    const doc = yield* library.tag(id, tagList);
    yield* Console.log(`OK Updated tags for "${doc.title}": ${tagList.join(", ")}`);
    return {
      resultPayload: doc,
      agentResult: { _tag: "tag", title: doc.title, tags: tagList },
    };
  });

const runStatsCommand: LibraryCommandHandler = ({ library, Console }) =>
  Effect.gen(function* () {
    const stats = yield* library.stats();
    yield* Console.log("PDF Library Stats");
    yield* Console.log("-----------------");
    yield* Console.log(`Documents:  ${stats.documents}`);
    yield* Console.log(`Chunks:     ${stats.chunks}`);
    yield* Console.log(`Embeddings: ${stats.embeddings}`);
    yield* Console.log(`Location:   ${stats.libraryPath}`);
    return {
      resultPayload: stats,
      agentResult: {
        _tag: "stats",
        documents: stats.documents,
        chunks: stats.chunks,
        embeddings: stats.embeddings,
      },
    };
  });

const commandHandlers: Readonly<
  Record<string, LibraryCommandHandler | undefined>
> = {
  chunk: runChunkCommand,
  doc: runDocumentCommand,
  page: runPageCommand,
  list: runListCommand,
  read: runReadCommand,
  get: runReadCommand,
  remove: runRemoveCommand,
  tag: runTagCommand,
  stats: runStatsCommand,
};

export function runLibraryCommand(
  args: string[],
  format: OutputFormat,
  library: CliLibrary,
  Console: CliConsole,
  verbose = false,
  options: Record<string, unknown> = {},
) {
  const command = args[0];
  const handler = command ? commandHandlers[command] : undefined;
  if (!handler) {
    return Effect.fail(
      new CLIError("UNKNOWN_COMMAND", `Unsupported library command: ${command}`, {
        command,
      }),
    );
  }

  return handler({
    args,
    command,
    format,
    library,
    Console,
    verbose,
    options,
  });
}
