export type ParsedArgs = Record<string, string | boolean>;

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
