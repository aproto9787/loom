import Anthropic from "@anthropic-ai/sdk";
import type { FlowNode, InvokeContext, InvokeEvent, RuntimeAdapter } from "@loom/core";

const DEFAULT_REPLY = "Mock Claude response";

function getPrompt(ctx: InvokeContext): string {
  return typeof ctx.resolvedInputs.prompt === "string"
    ? ctx.resolvedInputs.prompt
    : typeof ctx.resolvedInputs.topic === "string"
      ? ctx.resolvedInputs.topic
      : DEFAULT_REPLY;
}

class ClaudeApiAdapter implements RuntimeAdapter {
  public readonly id = "claude-api";

  supports(nodeType: FlowNode["type"]): boolean {
    return nodeType === "agent.claude";
  }

  async *invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    const mockEnabled = process.env.LOOM_MOCK === "1" || !process.env.ANTHROPIC_API_KEY;
    const topic = getPrompt(ctx);

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
      const fetchImpl = typeof ctx.node.config.fetch === "function"
        ? ctx.node.config.fetch as typeof globalThis.fetch
        : globalThis.fetch;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: fetchImpl });
      const model = typeof ctx.node.config.model === "string"
        ? ctx.node.config.model
        : "claude-sonnet-4-6";
      const system = typeof ctx.node.config.system === "string"
        ? ctx.node.config.system
        : undefined;
      const stream = await client.messages.stream({
        model,
        max_tokens: 512,
        system,
        messages: [{ role: "user", content: topic }],
      });

      let outputText = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          outputText += event.delta.text;
          yield { kind: "token", text: event.delta.text };
        }
      }

      if (outputText.length === 0) {
        throw new Error("anthropic stream returned no text");
      }

      yield { kind: "final", output: outputText };
    } catch (error) {
      yield {
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

export const claudeApiAdapter = new ClaudeApiAdapter();
