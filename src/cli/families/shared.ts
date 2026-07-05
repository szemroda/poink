import { Effect, type Layer } from "effect";
import type { GlobalCLIOptions } from "../runner.js";
import { CLIError } from "../runner.js";
import { withConfiguredLogging } from "../runtime.js";

export type FamilyCommandHandler = (
  args: string[],
  globals: GlobalCLIOptions,
  options: Record<string, unknown>,
) => Effect.Effect<unknown, unknown, unknown>;

export type FamilyCommandHandlers = ReadonlyMap<string, FamilyCommandHandler>;

export function commandHandlers(
  entries: ReadonlyArray<readonly [string, FamilyCommandHandler]>,
): FamilyCommandHandlers {
  return new Map(entries);
}

export function runResolvedFamilyCommand(
  familyName: string,
  handlers: FamilyCommandHandlers,
  args: string[],
  globals: GlobalCLIOptions,
  options: Record<string, unknown>,
): Effect.Effect<unknown, unknown, unknown> {
  const command = args[0];
  const handler = command ? handlers.get(command) : undefined;
  if (!handler) {
    return Effect.fail(
      new CLIError(
        "UNKNOWN_COMMAND",
        `Unknown ${familyName} command: ${command}`,
      ),
    );
  }

  return handler(args, globals, options);
}

export type FamilyLayer = Layer.Layer<unknown, unknown, never>;

export function toFamilyLayer<Services, Error>(
  layer: Layer.Layer<Services, Error, never>,
): FamilyLayer {
  return layer as unknown as FamilyLayer;
}

export async function runFamilyEffect(
  program: Effect.Effect<unknown, unknown, unknown>,
  globals: GlobalCLIOptions,
  layer?: FamilyLayer,
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
