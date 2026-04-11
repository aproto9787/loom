import type { InvokeContext, InvokeEvent, RuntimeAdapter } from "@loom/core";

export const litellmAdapterId = "litellm";

// The litellm adapter mirrors the mock-first strategy used by claude-api:
//  - If LOOM_MOCK=1 or LOOM_LITELLM_URL is unset we fabricate a response
//    that embeds the model name and user topic, splitting it into token
//    chunks so streaming consumers see a real stream.
//  - Otherwise we would POST to the configured LiteLLM proxy's OpenAI
//    chat completions endpoint. That real path is scaffolded below and
//    returns an explicit "not wired" error until we exercise a real
//    proxy subprocess in a later slice.
class LitellmAdapter implements RuntimeAdapter {
  readonly id = litellmAdapterId;

  supports(nodeType: string): boolean {
    return nodeType === "agent.litellm";
  }

  async *invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    const mockEnabled = process.env.LOOM_MOCK === "1" || !process.env.LOOM_LITELLM_URL;
    const model = typeof ctx.node.config.model === "string" ? ctx.node.config.model : "unknown-model";
    const topic = typeof ctx.resolvedInputs.topic === "string"
      ? ctx.resolvedInputs.topic
      : typeof ctx.resolvedInputs.prompt === "string"
        ? ctx.resolvedInputs.prompt
        : "anything";

    if (mockEnabled) {
      const reply = `LiteLLM(${model}) replies about ${topic}.`;
      const words = reply.split(" ");
      for (let index = 0; index < words.length; index += 1) {
        const chunk = index === 0 ? words[index] : ` ${words[index]}`;
        yield { kind: "token", text: chunk };
      }
      yield { kind: "final", output: reply };
      return;
    }

    try {
      throw new Error("litellm proxy path not wired yet (set LOOM_MOCK=1 for now)");
    } catch (error) {
      yield {
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

export const litellmAdapter = new LitellmAdapter();
