import { Effect, type Layer } from "effect";
import type { GlobalCLIOptions } from "../runner.js";
import { withConfiguredLogging } from "../runtime.js";

export async function runFamilyEffect(
  program: Effect.Effect<unknown, unknown, unknown>,
  globals: GlobalCLIOptions,
  layer?: Layer.Layer<unknown, unknown, never>,
): Promise<unknown> {
  const provided = layer
    ? program.pipe(Effect.provide(layer), Effect.scoped)
    : program;
  return Effect.runPromise(
    withConfiguredLogging(
      provided.pipe(Effect.either) as Effect.Effect<unknown, never, never>,
      globals.logLevel,
    ),
  );
}
