export * from "./types.js";
export * from "./claude-code/index.js";
export * from "./codex/index.js";
export { parseDelegationDirective, parseParallelDelegationDirective } from "./protocol.js";

import type { AgentType } from "@aproto9787/loom-core";
import { claudeCodeAdapter } from "./claude-code/index.js";
import { codexAdapter } from "./codex/index.js";
import type { AgentAdapter } from "./types.js";

const adaptersByType: Record<AgentType, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
};

export const agentAdapters = Object.values(adaptersByType);

export function getAgentAdapter(type: AgentType): AgentAdapter {
  return adaptersByType[type];
}
