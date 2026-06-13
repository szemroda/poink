export type ParsedArgs = Record<string, string | boolean>;

const DEFAULT_CHECKPOINT_INTERVAL = 50;

export function getCheckpointInterval(opts: ParsedArgs): number {
  const interval = opts["checkpoint-interval"];
  if (typeof interval !== "string") return DEFAULT_CHECKPOINT_INTERVAL;

  const parsedInterval = Number.parseInt(interval, 10);
  if (Number.isNaN(parsedInterval) || parsedInterval <= 0) {
    return DEFAULT_CHECKPOINT_INTERVAL;
  }

  return parsedInterval;
}

export function shouldCheckpoint(
  processedCount: number,
  interval: number,
): boolean {
  return processedCount > 0 && processedCount % interval === 0;
}

export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      result[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1);
      continue;
    }

    const rawKey = arg.slice(2);
    const negated = rawKey.startsWith("no-");
    const key = negated ? rawKey.slice(3) : rawKey;
    const nextArg = args[index + 1];

    if (!negated && nextArg && !nextArg.startsWith("--")) {
      result[key] = nextArg;
      index++;
      continue;
    }

    result[key] = !negated;
  }

  return result;
}
