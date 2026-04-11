import type { FlowNode, InvokeContext, InvokeEvent, RuntimeAdapter } from "@loom/core";

const DEFAULT_REPLY = "Mock Claude response";

class ClaudeApiAdapter implements RuntimeAdapter {
  public readonly id = "claude-api";

  supports(nodeType: FlowNode["type"]): boolean {
    return nodeType === "agent.claude";
  }

  async *invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    const mockEnabled = process.env.LOOM_MOCK === "1" || !process.env.ANTHROPIC_API_KEY;
    const topic = typeof ctx.resolvedInputs.prompt === "string"
      ? ctx.resolvedInputs.prompt
      : typeof ctx.resolvedInputs.topic === "string"
        ? ctx.resolvedInputs.topic
        : DEFAULT_REPLY;

    if (mockEnabled) {
      yield { kind: "token", text: `Thinking about ${topic}` };
      yield {
        kind: "final",
        output: `Mock Claude says hello about: ${topic}`,
      };
      return;
    }

    try {
      throw new Error("not wired");
    } catch (error) {
      yield {
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

export const claudeApiAdapter = new ClaudeApiAdapter();
