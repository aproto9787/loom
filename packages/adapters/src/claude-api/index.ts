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
      const reply = `Mock Claude says hello about: ${topic}`;
      // Split the mock reply into word-sized chunks so that downstream
      // consumers (runner, SSE endpoint, studio canvas) can observe a
      // realistic token stream instead of a single final blob.
      const words = reply.split(" ");
      for (let index = 0; index < words.length; index += 1) {
        const chunk = index === 0 ? words[index] : ` ${words[index]}`;
        yield { kind: "token", text: chunk };
      }
      yield { kind: "final", output: reply };
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
