import type { Layer } from "effect";
import { buildFullServerLayer } from "../runtime.js";
import type { FamilyRunner } from "./types.js";

export const runFamily: FamilyRunner = async ({
  parsed,
  globals,
  config,
}) => {
  const layer = (await buildFullServerLayer(
    config,
  )) as unknown as Layer.Layer<unknown, unknown, never>;
  if (parsed.args[0] === "mcp") {
    const { runMcpServer } = await import("../mcp.js");
    await runMcpServer(layer, globals);
    return undefined;
  }
  const { runServeCommand } = await import("../serve.js");
  await runServeCommand(layer, globals, parsed.args.slice(1), config);
  return undefined;
};
