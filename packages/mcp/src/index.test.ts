import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LoomMcpServer } from "./index.js";
import type { RunSubagentTaskResult } from "@aproto9787/loom-runtime";

async function createTestFlow(): Promise<{ root: string; flowPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "loom-mcp-test-"));
  const flowPath = path.join(root, "flow.yaml");
  await writeFile(flowPath, `
name: MCP Test
repo: .
orchestrator:
  name: leader
  type: codex
  agents:
    - name: reviewer
      type: codex
      system: Review patches.
    - name: disabled
      type: codex
      enabled: false
      system: Hidden worker.
`, "utf8");
  return { root, flowPath };
}

test("tools/list exposes only enabled direct children", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    const server = new LoomMcpServer({
      env: {
        LOOM_FLOW_PATH: flowPath,
        LOOM_FLOW_CWD: root,
        LOOM_AGENT: "leader",
        LOOM_SUBAGENT_BIN: "/tmp/loom-subagent.js",
      },
    });

    const response = await server.handleRequest({ id: 1, method: "tools/list" });
    const tools = (response?.result as { tools: Array<{ name: string; inputSchema: { properties: { agent?: { enum: string[] } } } }> }).tools;
    const delegateAgent = tools.find((tool) => tool.inputSchema.properties.agent)?.inputSchema.properties.agent;
    assert.deepEqual(delegateAgent?.enum, ["reviewer"]);
    assert.ok(tools.some((tool) => tool.name === "loom_delegate_reviewer"));
    assert.ok(tools.some((tool) => tool.name === "loom_oracle"));
    assert.ok(tools.some((tool) => tool.name === "loom_oracle_status"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loom_delegate rejects non-child agents before runner execution", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    const server = new LoomMcpServer({
      env: {
        LOOM_FLOW_PATH: flowPath,
        LOOM_FLOW_CWD: root,
        LOOM_AGENT: "leader",
        LOOM_SUBAGENT_BIN: "/tmp/loom-subagent.js",
      },
      delegateRunner: async () => {
        throw new Error("runner should not execute");
      },
    });

    const response = await server.handleRequest({
      id: 2,
      method: "tools/call",
      params: {
        name: "loom_delegate",
        arguments: { agent: "disabled", briefing: "review" },
      },
    });

    assert.equal((response?.error as { code: number }).code, -32000);
    assert.match((response?.error as { message: string }).message, /agent must be one of/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic delegate tools avoid reserved MCP tool names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "loom-mcp-test-"));
  const flowPath = path.join(root, "flow.yaml");
  await writeFile(flowPath, `
name: Reserved Tool Test
repo: .
orchestrator:
  name: leader
  type: codex
  agents:
    - name: many
      type: codex
      system: Reserved name worker.
`, "utf8");
  try {
    const server = new LoomMcpServer({
      env: {
        LOOM_FLOW_PATH: flowPath,
        LOOM_FLOW_CWD: root,
        LOOM_AGENT: "leader",
        LOOM_SUBAGENT_BIN: "/tmp/loom-subagent.js",
      },
    });

    const response = await server.handleRequest({ id: 3, method: "tools/list" });
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.ok(tools.includes("loom_delegate_many"));
    assert.ok(tools.includes("loom_delegate_many_2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function parseToolText(response: Awaited<ReturnType<LoomMcpServer["handleRequest"]>>): Record<string, unknown> {
  const content = (response?.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function fakeResult(agent: string, status: RunSubagentTaskResult["status"] = "done"): RunSubagentTaskResult {
  return {
    taskId: "runner-task",
    agent,
    status,
    exitCode: status === "done" ? 0 : 1,
    report: { status: status === "done" ? "done" : "unknown", summary: [], artifacts: [], blockers: [], raw: "" },
    reportPath: "/tmp/report.txt",
    stdout: "",
    stderr: "",
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}

async function createEventSink(): Promise<{ origin: string; bodies: unknown[]; close: () => Promise<void> }> {
  const bodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    bodies.push(JSON.parse(await readBody(request)));
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    bodies,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("loom_oracle_status reports Oracle as an optional external advisor", async () => {
  const server = new LoomMcpServer({ env: { PATH: "" } });

  const response = await server.handleRequest({
    id: 4,
    method: "tools/call",
    params: {
      name: "loom_oracle_status",
      arguments: {},
    },
  });

  const status = parseToolText(response);
  assert.deepEqual(status.plugin, { id: "oracle", displayName: "Oracle", kind: "external-advisor" });
  assert.deepEqual(status.oracle, { command: "oracle", available: false });
  assert.deepEqual(status.oracleMcp, { command: "oracle-mcp", available: false });
  assert.equal((status.npxFallback as { package: string }).package, "@steipete/oracle");
  assert.equal(status.attribution, "Oracle by steipete");
  assert.match(String(status.note), /does not vendor Oracle/);
});

test("loom_oracle calls the external advisor runner and records workflow events", async () => {
  const { root, flowPath } = await createTestFlow();
  const sink = await createEventSink();
  try {
    const server = new LoomMcpServer({
      env: {
        LOOM_FLOW_PATH: flowPath,
        LOOM_FLOW_CWD: root,
        LOOM_AGENT: "leader",
        LOOM_PARENT_DEPTH: "0",
        LOOM_RUN_ID: "oracle-run",
        LOOM_SERVER_ORIGIN: sink.origin,
        LOOM_SUBAGENT_BIN: "/tmp/loom-subagent.js",
      },
      oracleRunner: async (options) => {
        assert.equal(options.prompt, "review the architecture");
        assert.deepEqual(options.files, ["src/**/*.ts"]);
        assert.deepEqual(options.args, ["--dry-run", "summary"]);
        assert.equal(options.cwd, root);
        assert.equal(options.useNpxFallback, true);
        return {
          plugin: { id: "oracle", kind: "external-advisor" },
          status: "done",
          provider: "oracle",
          command: ["oracle", "-p", options.prompt],
          exitCode: 0,
          stdout: "oracle result",
          stderr: "",
          attribution: "Oracle by steipete",
        };
      },
    });

    const response = await server.handleRequest({
      id: 5,
      method: "tools/call",
      params: {
        name: "loom_oracle",
        arguments: {
          prompt: "review the architecture",
          files: ["src/**/*.ts"],
          args: ["--dry-run", "summary"],
        },
      },
    });

    const result = parseToolText(response);
    assert.equal(result.status, "done");
    assert.equal(result.stdout, "oracle result");
    assert.equal(sink.bodies.length, 2);
    assert.deepEqual(sink.bodies.map((body) => ((body as { events: Array<{ type: string }> }).events[0]!.type)), ["tool_use", "tool_result"]);
    assert.deepEqual(sink.bodies.map((body) => ((body as { events: Array<{ toolName: string }> }).events[0]!.toolName)), ["loom_oracle", "loom_oracle"]);
  } finally {
    await sink.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic delegate tools route to their child agent without waiting", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    let delegatedAgent = "";
    const server = new LoomMcpServer({
      env: {
        LOOM_FLOW_PATH: flowPath,
        LOOM_FLOW_CWD: root,
        LOOM_AGENT: "leader",
        LOOM_SUBAGENT_BIN: "/tmp/loom-subagent.js",
      },
      delegateRunner: async (options) => {
        delegatedAgent = options.agent.name;
        return fakeResult(options.agent.name);
      },
    });

    const response = await server.handleRequest({
      id: 3,
      method: "tools/call",
      params: {
        name: "loom_delegate_reviewer",
        arguments: { briefing: "review the patch" },
      },
    });

    assert.equal(parseToolText(response).agent, "reviewer");
    assert.equal(delegatedAgent, "reviewer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loom_delegate_many applies top-level timeout to tasks without their own timeout", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    const timeouts: number[] = [];
    const server = new LoomMcpServer({
      env: {
        LOOM_FLOW_PATH: flowPath,
        LOOM_FLOW_CWD: root,
        LOOM_AGENT: "leader",
        LOOM_SUBAGENT_BIN: "/tmp/loom-subagent.js",
      },
      delegateRunner: async (options) => {
        timeouts.push(options.timeoutSeconds ?? 0);
        return fakeResult(options.agent.name);
      },
    });

    await server.handleRequest({
      id: 4,
      method: "tools/call",
      params: {
        name: "loom_delegate_many",
        arguments: {
          timeoutSeconds: 17,
          tasks: [{ agent: "reviewer", briefing: "review" }],
        },
      },
    });

    assert.deepEqual(timeouts, [17]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loom_cancel aborts a running async task", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    const server = new LoomMcpServer({
      env: {
        LOOM_FLOW_PATH: flowPath,
        LOOM_FLOW_CWD: root,
        LOOM_AGENT: "leader",
        LOOM_SUBAGENT_BIN: "/tmp/loom-subagent.js",
      },
      delegateRunner: async (options) => new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => {
          resolve(fakeResult(options.agent.name, "cancelled"));
        }, { once: true });
      }),
    });

    const started = await server.handleRequest({
      id: 5,
      method: "tools/call",
      params: {
        name: "loom_delegate",
        arguments: { agent: "reviewer", briefing: "review", wait: false },
      },
    });
    const { taskId } = parseToolText(started);

    const cancelled = await server.handleRequest({
      id: 6,
      method: "tools/call",
      params: {
        name: "loom_cancel",
        arguments: { taskId },
      },
    });

    assert.equal(parseToolText(cancelled).cancelled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
