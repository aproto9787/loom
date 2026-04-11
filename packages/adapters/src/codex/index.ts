import type { FlowNode, InvokeContext, InvokeEvent, RuntimeAdapter } from "@loom/core";

export const codexAdapterId = "codex";

class CodexAdapter implements RuntimeAdapter {
  readonly id = codexAdapterId;

  supports(nodeType: FlowNode["type"]): boolean {
    return nodeType === "agent.codex";
  }

  async *invoke(_ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    yield {
      kind: "error",
      error: new Error("codex adapter not implemented yet (v0.1 stub)"),
    };
  }
}

export const codexAdapter = new CodexAdapter();
