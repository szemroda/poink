import { Effect, type Either } from "effect";
import type {
  CliLibrary,
  GlobalCLIOptions,
} from "../runner.js";
import { CLIError } from "../runner.js";
import { withConfiguredLogging } from "../runtime.js";

export type KnownFamilyError<E> = unknown extends E ? never : E;

export type FamilyCommandHandler<
  A,
  E,
  R = never,
  G extends GlobalCLIOptions<Pick<CliLibrary, "stats">> = GlobalCLIOptions,
> = (
  args: string[],
  globals: G,
  options: Record<string, unknown>,
) => Effect.Effect<A, E, R>;

export type FamilyCommandHandlers<
  A,
  E,
  R,
  G extends GlobalCLIOptions<Pick<CliLibrary, "stats">>,
> = ReadonlyMap<
  string,
  FamilyCommandHandler<A, E, R, G>
>;

export function commandHandlers<
  A,
  E,
  R = never,
  G extends GlobalCLIOptions<Pick<CliLibrary, "stats">> = GlobalCLIOptions,
>(
  entries: ReadonlyArray<readonly [string, FamilyCommandHandler<A, E, R, G>]>,
): FamilyCommandHandlers<A, E, R, G> {
  return new Map(entries);
}

export function runResolvedFamilyCommand<
  A,
  E,
  R,
  G extends GlobalCLIOptions<Pick<CliLibrary, "stats">>,
>(
  familyName: string,
  handlers: FamilyCommandHandlers<A, E, R, G>,
  args: string[],
  globals: G,
  options: Record<string, unknown>,
): Effect.Effect<A, E | CLIError, R> {
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

export async function runFamilyEffect<A, E>(
  program: Effect.Effect<A, E, never>,
  globals: GlobalCLIOptions,
): Promise<Either.Either<A, E>> {
  return Effect.runPromise(
    withConfiguredLogging(
      program.pipe(Effect.either),
      globals.logLevel,
    ),
    globals.signal ? { signal: globals.signal } : undefined,
  );
}
