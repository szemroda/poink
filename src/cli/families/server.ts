import { buildFullServerLayer } from "../runtime.js";
import { toFamilyLayer } from "./shared.js";
import type { FamilyRunner } from "./types.js";

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const [command, ...commandArgs] = parsed.args;
  const layer = toFamilyLayer(await buildFullServerLayer(config));

  if (command === "mcp") {
    const { runMcpServer } = await import("../mcp.js");
    return runMcpServer(layer, globals);
  }

  const { runServeCommand } = await import("../serve.js");
  return runServeCommand(layer, globals, commandArgs, config);
};
