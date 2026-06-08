import { Effect, Exit, Layer, Logger, Runtime, Scope } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";
import {
  makeErrorEnvelope,
  makeSuccessEnvelope,
  type OutputFormat,
} from "../agent/protocol.js";
import { toEffectLogLevel } from "../logger.js";
import {
  closeOpenAICodexProviderManager,
  withOpenAICodexProviderScope,
} from "../services/OpenAICodexProvider.js";
import {
  CLIError,
  describeCliFailure,
  VERSION,
  type GlobalCLIOptions,
} from "./runner.js";
import { dispatchCommand } from "./commands.js";
import { withConfiguredLogging } from "./runtime.js";

type MCPTransport =
  | StdioServerTransport
  | WebStandardStreamableHTTPServerTransport;

type CommandInvocation = {
  argv: string[];
  options?: Record<string, unknown>;
};

function forceJsonGlobals(globals: GlobalCLIOptions): GlobalCLIOptions {
  return {
    ...globals,
    format: "json" satisfies OutputFormat,
  };
}

export async function connectMcpServer<ROut, E>(
  appLayer: Layer.Layer<ROut, E, never>,
  globals: GlobalCLIOptions,
  transport: MCPTransport,
): Promise<() => Promise<void>> {
  const NextActionSchema = z.object({
    kind: z.literal("shell"),
    argv: z.array(z.string()),
    description: z.string().optional(),
  });

  const EnvelopeSchema = z.object({
    ok: z.boolean(),
    command: z.string(),
    protocolVersion: z.number().optional(),
    result: z.any().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.any().optional(),
      })
      .optional(),
    nextActions: z.array(NextActionSchema).optional(),
    meta: z.record(z.string(), z.any()).optional(),
  });

  const scope = await Effect.runPromise(Scope.make());
  const runtimeLayer = Layer.merge(
    appLayer,
    Logger.minimumLogLevel(toEffectLogLevel(globals.logLevel)),
  );
  const runtime = await Effect.runPromise(
    Layer.toRuntime(runtimeLayer).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const coerceCliError = (e: unknown): CLIError => {
    if (e instanceof CLIError) return e;
    const tag =
      e &&
      typeof e === "object" &&
      "_tag" in e &&
      typeof (e as { _tag?: unknown })._tag === "string"
        ? String((e as { _tag: string })._tag)
        : "UNKNOWN_ERROR";
    return new CLIError(tag, describeCliFailure(e), e);
  };

  const runCommand = async (
    invocation: CommandInvocation,
  ): Promise<z.infer<typeof EnvelopeSchema>> => {
    const startedAt = Date.now();
    const cmdGlobals = forceJsonGlobals(globals);
    const { argv, options = {} } = invocation;

    const outEither: any = await withOpenAICodexProviderScope(() =>
          Runtime.runPromise(
        runtime as any,
        withConfiguredLogging(
          dispatchCommand(argv, cmdGlobals, options).pipe(Effect.either),
          cmdGlobals.logLevel,
        ) as any,
      ),
    );

    if (outEither._tag === "Right") {
      const out: any = outEither.right;
      return makeSuccessEnvelope(out.command, out.result, {
        verbose: cmdGlobals.verbose,
        nextActions: out.nextActions,
        meta: out.meta ?? { poinkVersion: VERSION },
      });
    }

    const err = coerceCliError(outEither.left);
    return makeErrorEnvelope(
      argv[0] ?? "cli",
      { code: err.code, message: err.message, details: err.details },
      {
        verbose: cmdGlobals.verbose,
        meta: {
          poinkVersion: VERSION,
          timingMs: Date.now() - startedAt,
        },
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
    server.registerTool(
      name,
      {
        description: config.description,
        inputSchema: config.inputSchema as any,
        outputSchema: EnvelopeSchema as any,
      },
      (async (input: any) => {
        const envelope = await runCommand(toCommand(input));
        return {
          content: [{ type: "text", text: JSON.stringify(envelope) }],
          structuredContent: envelope,
        };
      }) as any,
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
        "Search documents (vector/hybrid/FTS) and optionally concepts. Use docsOnly/conceptsOnly for control.",
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
        "Run multiple searches and aggregate results. Uses progressive disclosure: chunk IDs first, content optional.",
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
    inputSchema: z.object({ fix: z.boolean().optional() }),
  }, (input) => {
    return { argv: ["doctor"], options: { fix: input.fix } };
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

  await server.connect(transport);

  return async () => {
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
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    } catch {
      // ignore
    }
  };
}

export async function runMcpServer<ROut, E>(
  appLayer: Layer.Layer<ROut, E, never>,
  globals: GlobalCLIOptions,
): Promise<void> {
  const transport = new StdioServerTransport();
  const closeMcp = await connectMcpServer(appLayer, globals, transport);

  const shutdown = async () => {
    await closeMcp();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}
