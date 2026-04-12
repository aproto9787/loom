import { rm } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "./index.js";
import { resetTraceStore } from "./trace-store.js";

void test("POST /runs returns MCP tool traces for agent.claude mock mode", async () => {
  resetTraceStore();
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
  resetTraceStore();
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

void test("PUT /flows/save round-trips a flow through YAML", async () => {
  resetTraceStore();
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";
  const app = buildServer();
  const flowPath = "examples/_roundtrip.yaml";

  try {
    const originalResponse = await app.inject({
      method: "GET",
      url: "/flows/get",
      query: { path: "examples/hello.yaml" },
    });

    assert.equal(originalResponse.statusCode, 200);
    const originalBody = originalResponse.json();

    const saveResponse = await app.inject({
      method: "PUT",
      url: "/flows/save",
      payload: {
        flowPath,
        flow: originalBody.flow,
      },
    });

    assert.equal(saveResponse.statusCode, 200);
    assert.deepEqual(saveResponse.json(), { flowPath });

    const loadedResponse = await app.inject({
      method: "GET",
      url: "/flows/get",
      query: { path: flowPath },
    });

    assert.equal(loadedResponse.statusCode, 200);
    const loadedBody = loadedResponse.json();
    assert.deepEqual(loadedBody.flow, originalBody.flow);
  } finally {
    await rm(new URL("../../../examples/_roundtrip.yaml", import.meta.url), { force: true });
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  }
});

void test("PUT /flows/save rejects invalid flow schema bodies", async () => {
  resetTraceStore();
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";
  const app = buildServer();

  try {
    const response = await app.inject({
      method: "PUT",
      url: "/flows/save",
      payload: {
        flowPath: "examples/invalid.yaml",
        flow: {
          version: "loom/v1",
          name: "Invalid",
          nodes: [
            {
              id: "broken",
              type: "not-a-real-node",
            },
          ],
          outputs: [],
        },
      },
    });

    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.ok(body.error);
    assert.equal(typeof body.error, "object");
    assert.ok(Array.isArray(body.error.formErrors));
    assert.ok(body.error.fieldErrors);
    assert.ok(Array.isArray(body.error.fieldErrors.flow));
  } finally {
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  }
});

void test("PUT /flows/save rejects escaped and non-yaml paths", async () => {
  resetTraceStore();
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";
  const app = buildServer();

  const validFlow = {
    version: "loom/v1",
    name: "Valid",
    inputs: [],
    mcps: [],
    nodes: [],
    outputs: [],
  };

  try {
    const escapedResponse = await app.inject({
      method: "PUT",
      url: "/flows/save",
      payload: {
        flowPath: "../../etc/passwd",
        flow: validFlow,
      },
    });

    assert.equal(escapedResponse.statusCode, 400);
    assert.match(JSON.stringify(escapedResponse.json().error), /examples\//);

    const extensionResponse = await app.inject({
      method: "PUT",
      url: "/flows/save",
      payload: {
        flowPath: "examples/foo.txt",
        flow: validFlow,
      },
    });

    assert.equal(extensionResponse.statusCode, 400);
    assert.match(JSON.stringify(extensionResponse.json().error), /\.yaml/);
  } finally {
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  }
});

void test("GET /runs lists persisted runs with pagination metadata", async () => {
  resetTraceStore();
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";
  const app = buildServer();

  try {
    for (const prompt of ["first run", "second run"]) {
      const runResponse = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          flowPath: "examples/mcp-tool-use.yaml",
          inputs: { prompt },
        },
      });
      assert.equal(runResponse.statusCode, 200);
    }

    const response = await app.inject({
      method: "GET",
      url: "/runs?page=1&pageSize=1",
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 1);
    assert.equal(body.runs.length, 1);
    assert.equal(typeof body.runs[0].runId, "string");
    assert.equal(body.runs[0].flowName, "MCP Tool Use Demo");
    assert.equal(body.runs[0].nodeCount, 3);
    assert.equal(typeof body.runs[0].createdAt, "string");
  } finally {
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  }
});

void test("GET /runs/:id returns ordered node results with timing fields", async () => {
  resetTraceStore();
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";
  const app = buildServer();

  try {
    const runResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        flowPath: "examples/mcp-tool-use.yaml",
        inputs: { prompt: "detail run" },
      },
    });

    assert.equal(runResponse.statusCode, 200);
    const runBody = runResponse.json();

    const response = await app.inject({
      method: "GET",
      url: `/runs/${runBody.runId}`,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.runId, runBody.runId);
    assert.equal(body.flowName, "MCP Tool Use Demo");
    assert.equal(body.flowPath, "examples/mcp-tool-use.yaml");
    assert.deepEqual(body.requestedInputs, { prompt: "detail run" });
    assert.equal(body.nodeResults.length, 3);
    assert.deepEqual(
      body.nodeResults.map((node: { nodeId: string }) => node.nodeId),
      ["claude_with_tools", "output", "prompt_input"],
    );
    for (const nodeResult of body.nodeResults) {
      assert.equal(typeof nodeResult.createdAt, "string");
      assert.equal(typeof nodeResult.startedAt, "string");
      assert.equal(typeof nodeResult.finishedAt, "string");
    }
  } finally {
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  }
});

void test("GET /runs/:id returns 404 for missing runs", async () => {
  resetTraceStore();
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";
  const app = buildServer();

  try {
    const response = await app.inject({
      method: "GET",
      url: "/runs/missing-run-id",
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: { message: "run not found" } });
  } finally {
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  }
});

void test("GET /runs returns runs array with default pagination", async () => {
  resetTraceStore();
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";
  const app = buildServer();

  try {
    const runResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        flowPath: "examples/mcp-tool-use.yaml",
        inputs: { prompt: "default list run" },
      },
    });

    assert.equal(runResponse.statusCode, 200);

    const response = await app.inject({
      method: "GET",
      url: "/runs",
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 20);
    assert.ok(Array.isArray(body.runs));
    assert.equal(body.runs.length, 1);
    assert.equal(typeof body.runs[0].runId, "string");
    assert.equal(body.runs[0].flowName, "MCP Tool Use Demo");
    assert.equal(body.runs[0].nodeCount, 3);
    assert.equal(typeof body.runs[0].createdAt, "string");
  } finally {
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  }
});
