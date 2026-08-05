import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Layer } from "effect";
import { describe, expect, test } from "vitest";
import type { GlobalCLIOptions } from "./runner.js";
import { connectMcpServer } from "./mcp.js";

const globals: GlobalCLIOptions = {
  format: "json",
  configuredDefaultFormat: "json",
  pretty: false,
  verbose: false,
  logLevel: "error",
};

describe("MCP runtime acquisition", () => {
  test("fails before starting the transport and closes partial resources", async () => {
    let starts = 0;
    let closes = 0;
    const transport = {
      start: async () => {
        starts++;
      },
      send: async () => {},
      close: async () => {
        closes++;
      },
    } satisfies Transport;

    await expect(
      connectMcpServer(
        Layer.fail(new Error("runtime layer failed")),
        globals,
        transport,
      ),
    ).rejects.toThrow("runtime layer failed");

    expect(starts).toBe(0);
    expect(closes).toBe(1);
  });
});
