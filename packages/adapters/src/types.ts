import type { AgentConfig, AgentType } from "@loom/core";

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "complete"; output: string }
  | { type: "error"; error: string }
  | { type: "delegate"; childAgent: string; reason: string };

export interface AgentAdapter {
  readonly type: AgentType;
  spawn(config: AgentConfig, input: string, cwd: string): AsyncGenerator<AgentEvent, void, undefined>;
}
