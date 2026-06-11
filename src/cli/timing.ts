import { performance } from "node:perf_hooks";
import type { AgentMeta } from "../agent/protocol.js";

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class InvocationTiming {
  private commandStartedAt: number | undefined;
  private commandMs: number | undefined;

  constructor(private readonly totalStartedAt: number) {}

  startCommand(): void {
    if (this.commandStartedAt === undefined) {
      this.commandStartedAt = performance.now();
    }
  }

  finishCommand(): void {
    if (this.commandStartedAt === undefined || this.commandMs !== undefined) {
      return;
    }
    this.commandMs = roundMilliseconds(performance.now() - this.commandStartedAt);
  }

  toAgentMeta(poinkVersion: string): AgentMeta {
    return {
      poinkVersion,
      timing: {
        totalMs: roundMilliseconds(performance.now() - this.totalStartedAt),
        ...(this.commandMs === undefined ? {} : { commandMs: this.commandMs }),
      },
    };
  }
}

export function createInvocationTiming(): InvocationTiming {
  return new InvocationTiming(performance.now());
}

export function createProcessInvocationTiming(): InvocationTiming {
  return new InvocationTiming(0);
}
