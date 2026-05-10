import type { LogLevel } from "./agent/protocol.js";
import { LogLevel as EffectLogLevel } from "effect";

let currentLevel: LogLevel = (() => {
  const raw = process.env.POINK_LOG_LEVEL;
  if (
    raw === "silent" ||
    raw === "error" ||
    raw === "info" ||
    raw === "debug"
  ) {
    return raw;
  }
  return "silent";
})();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
  process.env.POINK_LOG_LEVEL = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function toEffectLogLevel(level: LogLevel): EffectLogLevel.LogLevel {
  switch (level) {
    case "silent":
      return EffectLogLevel.None;
    case "error":
      return EffectLogLevel.Error;
    case "info":
      return EffectLogLevel.Info;
    case "debug":
      return EffectLogLevel.Debug;
  }
}
