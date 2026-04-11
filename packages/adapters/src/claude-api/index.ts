import Anthropic from "@anthropic-ai/sdk";
import type {
  FlowNode,
  InvokeContext,
  InvokeEvent,
  McpInvokeServer,
  RuntimeAdapter,
} from "@loom/core";

const DEFAULT_REPLY = "Mock Claude response";

type AnthropicMessage = {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
};

function getPrompt(ctx: InvokeContext): string {
  return typeof ctx.resolvedInputs.prompt === "string"
    ? ctx.resolvedInputs.prompt
    : typeof ctx.resolvedInputs.topic === "string"
      ? ctx.resolvedInputs.topic
      : DEFAULT_REPLY;
}

function getFirstMcpServer(ctx: InvokeContext): [string, McpInvokeServer] | undefined {
  return ctx.mcps ? Object.entries(ctx.mcps)[0] : undefined;
}

function buildMockToolArgs(topic: string): { text: string } {
  return { text: `mock tool input: ${topic}` };
}

function buildAnthropicTools(ctx: InvokeContext): Array<Record<string, unknown>> {
  return Object.entries(ctx.mcps ?? {}).flatMap(([serverId, server]) => server.tools.map((tool) => ({
    name: `${serverId}__${tool.name}`,
    description: tool.description,
    input_schema: tool.inputSchema ?? { type: "object", additionalProperties: true },
  })));
}

function parseAnthropicToolName(name: string): { serverId: string; toolName: string } {
  const divider = name.indexOf("__");
  if (divider === -1) {
    throw new Error(`invalid anthropic tool name: ${name}`);
  }
  return {
    serverId: name.slice(0, divider),
    toolName: name.slice(divider + 2),
  };
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
      const firstServer = getFirstMcpServer(ctx);
      if (!firstServer) {
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

      const [serverId, server] = firstServer;
      const tool = server.tools[0];
      if (!tool) {
        throw new Error(`mock Claude MCP server ${serverId} exposes no tools`);
      }
      const args = buildMockToolArgs(topic);
      yield { kind: "tool_call", name: tool.name, args };
      const result = await server.callTool(tool.name, args);
      yield { kind: "tool_result", name: tool.name, result };
      const reply = `Mock Claude says hello about: ${topic}\n[tool_call] ${JSON.stringify({ name: tool.name, arguments: args })}\n[tool_result] ${JSON.stringify(result)}`;
      for (const line of reply.split(/(\s+)/)) {
        if (line.length > 0) {
          yield { kind: "token", text: line };
        }
      }
      yield { kind: "final", output: reply };
      return;
    }

    try {
      const fetchImpl = typeof ctx.node.config.fetch === "function"
        ? ctx.node.config.fetch as typeof globalThis.fetch
        : globalThis.fetch;
      const client = typeof ctx.node.config.anthropicFactory === "function"
        ? ctx.node.config.anthropicFactory({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: fetchImpl }) as Anthropic
        : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: fetchImpl });
      const model = typeof ctx.node.config.model === "string"
        ? ctx.node.config.model
        : "claude-sonnet-4-6";
      const system = typeof ctx.node.config.system === "string"
        ? ctx.node.config.system
        : undefined;
      const tools = buildAnthropicTools(ctx);
      const messages: AnthropicMessage[] = [{
        role: "user",
        content: [{ type: "text", text: topic }],
      }];

      let outputText = "";
      while (true) {
        const stream = await client.messages.stream({
          model,
          max_tokens: 512,
          system,
          messages: messages as unknown as Anthropic.Messages.MessageParam[],
          tools: tools.length > 0 ? tools as unknown as Anthropic.Tool[] : undefined,
        });

        const assistantContent: Array<Record<string, unknown>> = [];
        const contentBlocks = new Map<number, Record<string, unknown>>();
        let pendingToolUse:
          | { id: string; name: string; input: unknown }
          | undefined;

        for await (const event of stream) {
          if (event.type === "content_block_start") {
            contentBlocks.set(event.index, event.content_block as unknown as Record<string, unknown>);
          }
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            outputText += event.delta.text;
            yield { kind: "token", text: event.delta.text };
          }
          if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
            const block = contentBlocks.get(event.index);
            if (block) {
              const current = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
              block.input = `${current}${event.delta.partial_json}`;
            }
          }
          if (event.type === "content_block_stop") {
            const block = contentBlocks.get(event.index);
            if (!block) {
              continue;
            }
            assistantContent.push(block);
            if (block.type === "tool_use") {
              const rawInput = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
              pendingToolUse = {
                id: String(block.id),
                name: String(block.name),
                input: rawInput.length > 0 ? JSON.parse(rawInput) : {},
              };
            }
          }
        }

        if (!pendingToolUse) {
          if (outputText.length === 0) {
            throw new Error("anthropic stream returned no text");
          }
          yield { kind: "final", output: outputText };
          return;
        }

        const { serverId, toolName } = parseAnthropicToolName(pendingToolUse.name);
        const server = ctx.mcps?.[serverId];
        if (!server) {
          throw new Error(`anthropic tool requested unknown MCP server ${serverId}`);
        }
        yield { kind: "tool_call", name: toolName, args: pendingToolUse.input };
        const result = await server.callTool(toolName, pendingToolUse.input);
        yield { kind: "tool_result", name: toolName, result };
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: pendingToolUse.id,
            content: JSON.stringify(result),
          }],
        });
      }
    } catch (error) {
      yield {
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

export const claudeApiAdapter = new ClaudeApiAdapter();
