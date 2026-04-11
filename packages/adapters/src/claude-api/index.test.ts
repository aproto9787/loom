import { test } from "node:test";
import assert from "node:assert/strict";
import type { InvokeContext } from "@loom/core";
import { claudeApiAdapter } from "./index.js";

void test("claudeApiAdapter real path executes MCP tool_use via mocked transport", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";

  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const responses = [
    [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "mock_tools__echo", input: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"text":"from mocked anthropic"}' },
      },
      { type: "content_block_stop", index: 0 },
    ],
    [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Anthropic final reply with tool result." },
      },
      { type: "content_block_stop", index: 0 },
    ],
  ];

  const streamInvocations: Array<Record<string, unknown>> = [];
  const ctx: InvokeContext = {
    node: {
      id: "claude",
      type: "agent.claude",
      config: {
        model: "claude-sonnet-4-6",
        fetch: ((() => Promise.reject(new Error("unused fetch"))) as unknown as typeof globalThis.fetch),
        anthropicFactory: () => ({
          messages: {
            stream: async (payload: Record<string, unknown>) => {
              streamInvocations.push(payload);
              const events = responses.shift() ?? [];
              return {
                async *[Symbol.asyncIterator]() {
                  for (const event of events) {
                    yield event;
                  }
                },
              };
            },
          },
        }),
      },
      mcps: ["mock_tools"],
      inputs: {},
      outputs: {},
      branches: [],
    },
    resolvedInputs: { prompt: "use the MCP tool" },
    mcps: {
      mock_tools: {
        tools: [{
          name: "echo",
          description: "Echo text",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        }],
        callTool: async (name, args) => {
          toolCalls.push({ name, args });
          return { content: [{ type: "text", text: "from mocked anthropic" }] };
        },
      },
    },
  };

  const events = [];
  for await (const event of claudeApiAdapter.invoke(ctx)) {
    events.push(event);
  }

  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0], { name: "echo", args: { text: "from mocked anthropic" } });
  assert.equal(streamInvocations.length, 2);
  assert.deepEqual(streamInvocations[0].tools, [{
    name: "mock_tools__echo",
    description: "Echo text",
    input_schema: { type: "object", properties: { text: { type: "string" } } },
  }]);
  assert.match(JSON.stringify(streamInvocations[1].messages), /tool_result/);
  assert.deepEqual(events.filter((event) => event.kind === "tool_call"), [
    { kind: "tool_call", name: "echo", args: { text: "from mocked anthropic" } },
  ]);
  assert.deepEqual(events.at(-1), { kind: "final", output: "Anthropic final reply with tool result." });

  delete process.env.ANTHROPIC_API_KEY;
});
