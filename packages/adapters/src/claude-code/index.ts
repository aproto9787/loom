import type { InvokeContext, InvokeEvent, RuntimeAdapter } from "@loom/core";

export const claudeCodeAdapterId = "claude-code";

class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = claudeCodeAdapterId;

  supports(nodeType: string): boolean {
    return nodeType === "agent.claude-code";
  }

  async *invoke(_ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    yield {
      kind: "error",
      error: new Error("claude-code adapter not implemented yet (v0.1 stub)"),
    };
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
