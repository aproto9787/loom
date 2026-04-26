import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("dynamic delegate tools route to their child agent", async () => {
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
