import { Effect } from "effect";
import type { OutputFormat } from "../../agent/protocol.js";
import type { Document } from "../../types.js";
import { CLIError, type CliLibrary } from "../runner.js";
import type { CliCommandOutput, CliConsole } from "./types.js";

export type DocumentSummary = Pick<
  Document,
  "id" | "title" | "pageCount" | "tags" | "fileType"
>;

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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === name) return args[i + 1];
    if (arg.startsWith(equalsPrefix)) return arg.slice(equalsPrefix.length);
  }
  return undefined;
}

export function runLibraryCommand(
  args: string[],
  format: OutputFormat,
  library: CliLibrary,
  Console: CliConsole,
  verbose = false,
  options: Record<string, unknown> = {},
) {
  return Effect.gen(function* (): Generator<any, CliCommandOutput, any> {
    const command = args[0];
    let resultPayload: unknown = null;

    switch (command) {
      case "chunk": {
        const subcommand = args[1];
        if (subcommand !== "get") {
          yield* Console.error("Usage: poink chunk get <chunkId>");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "Unknown chunk subcommand", {
              subcommand,
              hint: "poink chunk get <chunkId>",
            }),
          );
        }

        const chunkId = args[2];
        if (!chunkId) {
          yield* Console.error("Error: chunkId required");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "chunkId required", {
              command: "chunk get",
            }),
          );
        }

        const chunk = yield* library.getChunk(chunkId);
        if (!chunk) {
          yield* Console.error(`Chunk not found: ${chunkId}`);
          return yield* Effect.fail(
            new CLIError("NOT_FOUND", `Chunk not found: ${chunkId}`, { chunkId }),
          );
        }

        if (format === "text") {
          yield* Console.log(chunk.content);
        }
        return { resultPayload: chunk, agentResult: null };
      }

      case "doc": {
        const subcommand = args[1];
        if (subcommand !== "chunks") {
          yield* Console.error("Usage: poink doc chunks <docId> [--page N]");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "Unknown doc subcommand", {
              subcommand,
              hint: "poink doc chunks <docId> [--page N]",
            }),
          );
        }

        const docId = args[2];
        if (!docId) {
          yield* Console.error("Error: docId required");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "docId required", {
              command: "doc chunks",
            }),
          );
        }

        const pageValue =
          typeof options.page === "number" || typeof options.page === "string"
            ? String(options.page)
            : optionValue(args.slice(3), "--page");
        const page = pageValue ? Number(pageValue) : undefined;

        if (page !== undefined && (Number.isNaN(page) || page <= 0)) {
          yield* Console.error(`Error: --page must be a positive number`);
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "--page must be a positive number", {
              page: pageValue,
            }),
          );
        }

        const chunks = yield* library.listChunksByDocument(docId, {
          page: page === undefined ? undefined : page,
        });

        resultPayload = {
          docId,
          page: page ?? null,
          chunks: chunks.map((c) => ({
            id: c.id,
            docId: c.docId,
            page: c.page,
            chunkIndex: c.chunkIndex,
          })),
        };

        if (format === "text") {
          for (const c of chunks) {
            yield* Console.log(`${c.id}\tpage=${c.page}\tchunkIndex=${c.chunkIndex}`);
          }
        }
        return { resultPayload, agentResult: null };
      }

      case "page": {
        const subcommand = args[1];
        if (subcommand !== "get") {
          yield* Console.error("Usage: poink page get <docId> <page>");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "Unknown page subcommand", {
              subcommand,
              hint: "poink page get <docId> <page>",
            }),
          );
        }

        const docId = args[2];
        const page = args[3] ? Number(args[3]) : NaN;
        if (!docId || Number.isNaN(page) || page <= 0) {
          yield* Console.error("Error: docId and page required");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "docId and page required", {
              docId,
              page: args[3],
            }),
          );
        }

        const chunks = yield* library.listChunksByDocument(docId, { page });
        const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
        const content = sorted.map((c) => c.content).join("\n\n");

        resultPayload = {
          docId,
          page,
          chunkCount: sorted.length,
          chunkIds: sorted.map((c) => c.id),
          content,
        };

        if (format === "text") {
          yield* Console.log(content);
        }
        return { resultPayload, agentResult: null };
      }

      case "list": {
        const tag =
          typeof options.tag === "string"
            ? options.tag
            : optionValue(args.slice(1), "--tag");

        const docs = yield* library.list(tag);
        resultPayload = verbose
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
            firstDoc: docs.length > 0 ? { title: docs[0]!.title, id: docs[0]!.id } : undefined,
          },
        };
      }

      case "read":
      case "get": {
        const id = args[1];
        if (!id) {
          yield* Console.error("Error: ID or title required");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "ID or title required", {
              command,
            }),
          );
        }

        const doc = yield* library.get(id);
        if (!doc) {
          yield* Console.error(`Not found: ${id}`);
          return yield* Effect.fail(
            new CLIError("NOT_FOUND", `Not found: ${id}`, {
              idOrTitle: id,
            }),
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
          agentResult: { _tag: "read", title: doc.title, id: doc.id, tags: [...doc.tags] },
        };
      }

      case "remove": {
        const id = args[1];
        if (!id) {
          yield* Console.error("Error: ID or title required");
          return yield* Effect.fail(
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
      }

      case "tag": {
        const id = args[1];
        const tags = args[2];
        if (!id || !tags) {
          yield* Console.error("Error: ID and tags required");
          return yield* Effect.fail(
            new CLIError("INVALID_ARGS", "ID and tags required", {
              command: "tag",
            }),
          );
        }

        const tagList = tags.split(",").map((t) => t.trim());
        const doc = yield* library.tag(id, tagList);
        yield* Console.log(`OK Updated tags for "${doc.title}": ${tagList.join(", ")}`);
        return {
          resultPayload: doc,
          agentResult: { _tag: "tag", title: doc.title, tags: tagList },
        };
      }

      case "stats": {
        const stats = yield* library.stats();
        yield* Console.log(`PDF Library Stats`);
        yield* Console.log(`-----------------`);
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
      }

      default:
        return yield* Effect.fail(
          new CLIError("UNKNOWN_COMMAND", `Unsupported library command: ${command}`, {
            command,
          }),
        );
    }
  });
}
