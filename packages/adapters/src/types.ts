import type { AgentConfig, AgentType } from "@aproto9787/loom-core";

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "complete"; output: string }
  | { type: "error"; error: string }
  | { type: "delegate"; childAgent: string; reason: string };

export interface SpawnController {
  signal?: AbortSignal;
  timeoutMs?: number;
  onAbort?: () => void;
  onTimeout?: () => void;
  env?: Record<string, string | undefined>;
  isolatedHome?: string;
}

export interface AgentAdapter {
  readonly type: AgentType;
  spawn(config: AgentConfig, input: string, cwd: string, controller?: SpawnController): AsyncGenerator<AgentEvent, void, undefined>;
}
