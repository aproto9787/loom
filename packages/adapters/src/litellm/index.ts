import type { InvokeContext, InvokeEvent, RuntimeAdapter } from "@loom/core";

export const litellmAdapterId = "litellm";

class LitellmAdapter implements RuntimeAdapter {
  readonly id = litellmAdapterId;

  supports(nodeType: string): boolean {
    return nodeType === "agent.litellm";
  }

  async *invoke(_ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    yield {
      kind: "error",
      error: new Error("litellm adapter not implemented yet (v0.1 stub)"),
    };
  }
}

export const litellmAdapter = new LitellmAdapter();
