import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import {
  McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  makeErrorEnvelope,
  makeSuccessEnvelope,
  type NextAction,
  type OutputFormat,
} from "../agent/protocol.js";
import { toEffectLogLevel } from "../logger.js";
import {
  closeOpenAICodexProviderManager,
  withOpenAICodexProviderScope,
} from "../services/OpenAICodexProvider.js";
import { DocumentIngestion } from "../services/DocumentIngestion.js";
import { LibraryStore } from "../services/LibraryStore.js";
import { SemanticLibrary } from "../services/SemanticLibrary.js";
import { DocumentIntegrityRepository } from "../services/StorageRepositories.js";
import {
  VERSION,
  type GlobalCLIOptions,
  type CliLibrary,
} from "./runner.js";
import { coerceCliError } from "./errors.js";
import { waitForShutdownSignal } from "../runtime.js";
import {
  dispatchCommand,
  type CommandServices,
} from "./commands.js";
import { withConfiguredLogging } from "./runtime.js";
import {
  createInvocationTiming,
  type InvocationTiming,
} from "./timing.js";

type CommandInvocation = {
  argv: string[];
  options?: Record<string, unknown>;
};

type CommandOutput = {
  command: string;
  result: unknown;
  nextActions?: NextAction[];
};

function forceJsonGlobals(globals: GlobalCLIOptions): GlobalCLIOptions {
  return {
    ...globals,
    format: "json" satisfies OutputFormat,
  };
}

export type McpServices =
  | CommandServices
  | LibraryStore
  | SemanticLibrary
  | DocumentIngestion
  | DocumentIntegrityRepository;

export async function connectMcpServer<E>(
  appLayer: Layer.Layer<McpServices, E, never>,
  globals: GlobalCLIOptions,
  transport: Transport,
): Promise<() => Promise<void>> {
  const NextActionSchema = z.object({
    kind: z.literal("shell"),
    argv: z.array(z.string()),
    description: z.string().optional(),
  });

  const EnvelopeSchema = z.object({
    ok: z.boolean(),
    command: z.string(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .optional(),
    nextActions: z.array(NextActionSchema).optional(),
    meta: z
      .object({
        poinkVersion: z.string(),
        timing: z.object({
          totalMs: z.number(),
          commandMs: z.number().optional(),
        }),
      })
      .optional(),
  });

  const runtimeLayer = Layer.merge(
    appLayer,
    Logger.minimumLogLevel(toEffectLogLevel(globals.logLevel)),
  );
  const runtime = ManagedRuntime.make(runtimeLayer);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await transport.close();
    } catch {
      // ignore
    }
    try {
      await closeOpenAICodexProviderManager();
    } catch {
      // ignore
    }
    try {
      await runtime.dispose();
    } catch {
      // ignore
    }
  };

  type Envelope = z.infer<typeof EnvelopeSchema>;

  const isCommandOutput = (value: unknown): value is CommandOutput => {
    return (
      typeof value === "object" &&
      value !== null &&
      "command" in value &&
      typeof value.command === "string"
    );
  };

  const runCommand = async (
    invocation: CommandInvocation,
    timing: InvocationTiming,
    signal: AbortSignal,
  ): Promise<Envelope> => {
    const cmdGlobals = { ...forceJsonGlobals(globals), timing };
    const { argv, options = {} } = invocation;

    const commandProgram = Effect.gen(function* () {
      const store = yield* LibraryStore;
      const semantic = yield* SemanticLibrary;
      const ingestion = yield* DocumentIngestion;
      const integrity = yield* DocumentIntegrityRepository;
      const library = {
        ...store,
        ...semantic,
        ...ingestion,
        getWithSourceIdentity: integrity.getDocumentWithSourceIdentity,
        listWithSourceIdentity: integrity.listDocumentsWithSourceIdentity,
      } satisfies CliLibrary;
      return yield* dispatchCommand(
        argv,
        {
          ...cmdGlobals,
          library,
        },
        options,
      );
    }).pipe(Effect.either);
    const outEither = await withOpenAICodexProviderScope(() =>
      runtime.runPromise(
        withConfiguredLogging(commandProgram, cmdGlobals.logLevel),
        { signal },
      ),
    );

    if (outEither._tag === "Right" && isCommandOutput(outEither.right)) {
      const out = outEither.right;
      return makeSuccessEnvelope(out.command, out.result, {
        verbose: cmdGlobals.verbose,
        nextActions: out.nextActions,
        meta: timing.toAgentMeta(VERSION),
      });
    }

    const err = coerceCliError(
      outEither._tag === "Right" ? outEither.right : outEither.left,
    );
    return makeErrorEnvelope(
      argv[0] ?? "cli",
      { code: err.code, message: err.message, details: err.details },
      {
        verbose: cmdGlobals.verbose,
        meta: timing.toAgentMeta(VERSION),
      },
    );
  };

  const server = new McpServer({ name: "poink", version: VERSION });

  const tool = <TInput extends z.ZodTypeAny>(
    name: string,
    config: {
      description: string;
      inputSchema: TInput;
    },
    toCommand: (input: z.infer<TInput>) => CommandInvocation,
  ) => {
    const runTool = (async (
      input: unknown,
      extra: { signal: AbortSignal },
    ): Promise<CallToolResult> => {
      const timing = createInvocationTiming();
      const parsed = config.inputSchema.parse(input);
      const envelope = await runCommand(
        toCommand(parsed),
        timing,
        extra.signal,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
        isError: !envelope.ok,
      };
    }) as unknown as ToolCallback<TInput>;

    server.registerTool<typeof EnvelopeSchema, TInput>(
      name,
      {
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: EnvelopeSchema,
      },
      runTool,
    );
  };

  tool(
    "capabilities",
    {
      description:
        "Describe poink commands and flags (agent discovery entrypoint).",
      inputSchema: z.object({}).optional(),
    },
    () => ({ argv: ["capabilities"] }),
  );

  tool(
    "config_schema",
    {
      description: "Retrieve the complete poink configuration JSON Schema.",
      inputSchema: z.object({}).optional(),
    },
    () => ({ argv: ["config", "schema"] }),
  );

  tool("stats", {
    description: "Library statistics (documents/chunks/embeddings).",
    inputSchema: z.object({}).optional(),
  }, () => ({ argv: ["stats"] }));

  tool(
    "search",
    {
      description:
        "Search documents and optionally concepts. Document search is hybrid by default and fails if embeddings are unavailable; set fts=true for explicit full-text search.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().positive().optional(),
        tag: z.string().optional(),
        fts: z.boolean().optional(),
        expand: z.number().int().min(0).max(4000).optional(),
        docsOnly: z.boolean().optional(),
        conceptsOnly: z.boolean().optional(),
        includeClusters: z.boolean().optional(),
      }),
    },
    (input) => {
      return {
        argv: ["search", input.query],
        options: {
          limit: input.limit,
          tag: input.tag,
          fts: input.fts,
          expand: input.expand,
          docsOnly: input.docsOnly,
          "docs-only": input.docsOnly,
          conceptsOnly: input.conceptsOnly,
          "concepts-only": input.conceptsOnly,
          includeClusters: input.includeClusters,
          "include-clusters": input.includeClusters,
        },
      };
    },
  );

  tool(
    "search_pack",
    {
      description:
        "Run multiple hybrid searches and aggregate results. Fails if embeddings are unavailable unless fts=true. Uses progressive disclosure: chunk IDs first, content optional.",
      inputSchema: z.object({
        queries: z.array(z.string()).min(1),
        limit: z.number().int().positive().optional(),
        tag: z.string().optional(),
        fts: z.boolean().optional(),
        expand: z.number().int().min(0).max(4000).optional(),
        withContent: z.boolean().optional(),
        globalLimit: z.number().int().positive().optional(),
      }),
    },
    (input) => {
      return {
        argv: ["search-pack", ...input.queries],
        options: {
          limit: input.limit,
          tag: input.tag,
          fts: input.fts,
          expand: input.expand,
          withContent: input.withContent,
          "with-content": input.withContent,
          globalLimit: input.globalLimit,
          "global-limit": input.globalLimit,
        },
      };
    },
  );

  tool("read", {
    description: "Read document metadata by id or title.",
    inputSchema: z.object({ idOrTitle: z.string() }),
  }, (input) => ({ argv: ["read", input.idOrTitle] }));

  tool("list", {
    description: "List documents, optionally filtered by tag.",
    inputSchema: z.object({ tag: z.string().optional() }),
  }, (input) => {
    return { argv: ["list"], options: { tag: input.tag } };
  });

  tool("chunk_get", {
    description: "Progressive disclosure: fetch a single chunk by chunkId.",
    inputSchema: z.object({ chunkId: z.string() }),
  }, (input) => ({ argv: ["chunk", "get", input.chunkId] }));

  tool("doc_chunks", {
    description: "Progressive disclosure: list chunk IDs for a document (optionally by page).",
    inputSchema: z.object({
      docId: z.string(),
      page: z.number().int().positive().optional(),
    }),
  }, (input) => {
    return { argv: ["doc", "chunks", input.docId], options: { page: input.page } };
  });

  tool("page_get", {
    description: "Progressive disclosure: reconstruct full page text for a doc/page.",
    inputSchema: z.object({ docId: z.string(), page: z.number().int().positive() }),
  }, (input) => ({ argv: ["page", "get", input.docId, String(input.page)] }));

  tool("taxonomy_list", {
    description: "List taxonomy concept summaries.",
    inputSchema: z.object({}).optional(),
  }, () => ({ argv: ["taxonomy", "list"] }));

  tool("taxonomy_tree", {
    description: "Render taxonomy hierarchy (full or rooted).",
    inputSchema: z.object({ rootId: z.string().optional() }),
  }, (input) => {
    const argv = ["taxonomy", "tree"];
    if (typeof input.rootId === "string" && input.rootId.length > 0) argv.push(input.rootId);
    return { argv };
  });

  tool("taxonomy_get", {
    description: "Get full taxonomy concept details and relationships.",
    inputSchema: z.object({ id: z.string() }),
  }, (input) => ({ argv: ["taxonomy", "get", input.id] }));

  tool("taxonomy_search", {
    description: "Search taxonomy concepts via vector similarity or text fallback.",
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().int().positive().optional(),
      threshold: z.number().min(0).max(1).optional(),
    }),
  }, (input) => {
    return {
      argv: ["taxonomy", "search", input.query],
      options: { limit: input.limit, threshold: input.threshold },
    };
  });

  tool("doctor", {
    description: "Health check and upgrade recommendations.",
    inputSchema: z.object({
      fix: z.boolean().optional(),
      deep: z.boolean().optional(),
    }),
  }, (input) => {
    return {
      argv: ["doctor"],
      options: { fix: input.fix, deep: input.deep },
    };
  });

  tool("rechunk", {
    description:
      "Rebuild chunks + embeddings. By default, only docs with mismatched chunker metadata are included; pass includeMissing for legacy docs.",
    inputSchema: z.object({
      docId: z.string().optional(),
      tag: z.string().optional(),
      dryRun: z.boolean().optional(),
      includeMissing: z.boolean().optional(),
      maxDocs: z.number().int().positive().optional(),
      maxChunks: z.number().int().positive().optional(),
      all: z.boolean().optional(),
    }),
  }, (input) => {
    return {
      argv: ["rechunk"],
      options: {
        doc: input.docId,
        tag: input.tag,
        dryRun: input.dryRun,
        "dry-run": input.dryRun,
        includeMissing: input.includeMissing,
        "include-missing": input.includeMissing,
        maxDocs: input.maxDocs,
        "max-docs": input.maxDocs,
        maxChunks: input.maxChunks,
        "max-chunks": input.maxChunks,
        all: input.all,
      },
    };
  });

  try {
    await runtime.runtime();
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }

  return close;
}

export async function runMcpServer<E>(
  appLayer: Layer.Layer<McpServices, E, never>,
  globals: GlobalCLIOptions,
): Promise<void> {
  const transport = new StdioServerTransport();
  const closeMcp = await connectMcpServer(appLayer, globals, transport);

  try {
    await waitForShutdownSignal(globals.signal);
  } finally {
    await closeMcp();
  }
}
