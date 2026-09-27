import { buildIngestionLayer } from "../runtime.js";
import type { FamilyRunner } from "./types.js";

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const command = parsed.args[0];
  const layer = await buildIngestionLayer(config);

  if (command === "mcp") {
    const { runMcpServer } = await import("../mcp.js");
    return runMcpServer(layer, globals);
  }

  const { runServeCommand } = await import("../serve.js");
  return runServeCommand(layer, globals, parsed.options, config);
};
