import type { Layer } from "effect";
import { buildFullServerLayer } from "../runtime.js";
import type { FamilyRunner } from "./types.js";

type ServerLayer = Layer.Layer<unknown, unknown, never>;

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const [command, ...commandArgs] = parsed.args;
  const layer = (await buildFullServerLayer(config)) as unknown as ServerLayer;

  if (command === "mcp") {
    const { runMcpServer } = await import("../mcp.js");
    return runMcpServer(layer, globals);
  }

  const { runServeCommand } = await import("../serve.js");
  return runServeCommand(layer, globals, commandArgs, config);
};
