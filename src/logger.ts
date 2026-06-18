import type { LogLevel } from "./agent/protocol.js";
import { LogLevel as EffectLogLevel } from "effect";

const LOG_LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  "silent",
  "error",
  "info",
  "debug",
]);

const EFFECT_LOG_LEVELS: Readonly<Record<LogLevel, EffectLogLevel.LogLevel>> = {
  silent: EffectLogLevel.None,
  error: EffectLogLevel.Error,
  info: EffectLogLevel.Info,
  debug: EffectLogLevel.Debug,
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return value !== undefined && LOG_LEVELS.has(value);
}

let currentLevel: LogLevel = isLogLevel(process.env.POINK_LOG_LEVEL)
  ? process.env.POINK_LOG_LEVEL
  : "silent";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
  process.env.POINK_LOG_LEVEL = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function toEffectLogLevel(level: LogLevel): EffectLogLevel.LogLevel {
  return EFFECT_LOG_LEVELS[level];
}
