export * from "./claude-api/index.js";

import type { FlowNode, RuntimeAdapter } from "@loom/core";
import { claudeApiAdapter } from "./claude-api/index.js";

class StubAdapter implements RuntimeAdapter {
  constructor(
    public readonly id: string,
    private readonly supported: FlowNode["type"][],
  ) {}

  supports(nodeType: FlowNode["type"]): boolean {
    return this.supported.includes(nodeType);
  }

  async *invoke(): AsyncIterable<never> {
    throw new Error(`${this.id} is not implemented in this slice`);
  }
}

export const runtimeAdapters: RuntimeAdapter[] = [
  claudeApiAdapter,
  new StubAdapter("litellm", ["agent.litellm"]),
  new StubAdapter("claude-code", ["agent.claude-code"]),
  new StubAdapter("codex", ["agent.codex"]),
];
