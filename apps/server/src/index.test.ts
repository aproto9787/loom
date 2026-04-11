import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "./index.js";

void test("POST /runs returns MCP tool traces for agent.claude mock mode", async () => {
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";
  const app = buildServer();

  try {
    const response = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        flowPath: "examples/mcp-tool-use.yaml",
        inputs: { prompt: "echo this from test" },
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    const agentNode = body.nodeResults.find((node: { nodeId: string }) => node.nodeId === "claude_with_tools");
    assert.ok(agentNode);
    const output = String(agentNode.output.output);
    assert.match(output, /\[tool_call\] \{"name":"echo","arguments":\{"text":"mock tool input: echo this from test"\}\}/);
    assert.match(output, /\[tool_result\] \{"content":\[\{"type":"text","text":"mock tool input: echo this from test"\}\]\}/);
  } finally {
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  }
});

void test("POST /runs\/stream keeps MCP tool metadata for mcp.server nodes", async () => {
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";
  const app = buildServer();

  try {
    const response = await app.inject({
      method: "POST",
      url: "/runs/stream",
      payload: {
        flowPath: "examples/mcp-demo.yaml",
        inputs: {},
      },
    });

    assert.equal(response.statusCode, 200);
    const payload = response.body;
    assert.match(payload, /event: node_complete\ndata: .*"nodeId":"tools_server".*"meta":\{"mcp":\{"tools":\[/s);
    assert.match(payload, /"toolNames":\["echo","upper"\]/);
  } finally {
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  }
});
