import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HeddleMcpServer } from "./index.js";
import type { RunSubagentTaskResult } from "@aproto9787/heddle-runtime";

async function createTestFlow(): Promise<{ root: string; flowPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "heddle-mcp-test-"));
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
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
      },
    });

    const response = await server.handleRequest({ id: 1, method: "tools/list" });
    const tools = (response?.result as { tools: Array<{ name: string; inputSchema: { properties: { agent?: { enum: string[] } } } }> }).tools;
    const toolNames = tools.map((tool) => tool.name);
    const delegateAgent = tools.find((tool) => tool.inputSchema.properties.agent)?.inputSchema.properties.agent;
    assert.deepEqual(delegateAgent?.enum, ["reviewer"]);
    assert.ok(toolNames.includes("heddle_delegate_reviewer"));
    assert.ok(toolNames.includes("heddle_record_gate"));
    assert.ok(toolNames.includes("heddle_read_manifest"));
    assert.ok(toolNames.includes("heddle_update_manifest"));
    assert.ok(toolNames.includes("heddle_require_approval"));
    assert.ok(toolNames.includes("heddle_record_approval"));
    assert.ok(toolNames.includes("heddle_record_rollback"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heddle_delegate rejects non-child agents before runner execution", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
      },
      delegateRunner: async () => {
        throw new Error("runner should not execute");
      },
    });

    const response = await server.handleRequest({
      id: 2,
      method: "tools/call",
      params: {
        name: "heddle_delegate",
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
  const root = await mkdtemp(path.join(os.tmpdir(), "heddle-mcp-test-"));
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
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
      },
    });

    const response = await server.handleRequest({ id: 3, method: "tools/list" });
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.ok(tools.includes("heddle_delegate_many"));
    assert.ok(tools.includes("heddle_delegate_many_2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function parseToolText(response: Awaited<ReturnType<HeddleMcpServer["handleRequest"]>>): Record<string, unknown> {
  const content = (response?.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

test("governance tools post typed events and read the run manifest", async () => {
  const { root, flowPath } = await createTestFlow();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ url, body });
    if (url.endsWith("/runs/run-1/manifest")) {
      return new Response(JSON.stringify({
        runId: "run-1",
        hasGovernance: true,
        manifest: {
          runId: "run-1",
          request: "change setting",
          interpretedGoal: "guard the change",
          riskTier: "side_effect",
          governancePack: "side-effect-guarded",
          workers: ["leader"],
          gates: [],
          result: "running",
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ runId: "run-1", count: 1 }), { status: 201 });
  }) as typeof fetch;

  try {
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_RUN_ID: "run-1",
        HEDDLE_SERVER_ORIGIN: "http://127.0.0.1:8787",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
      },
    });

    const recordResponse = await server.handleRequest({
      id: 11,
      method: "tools/call",
      params: {
        name: "heddle_record_gate",
        arguments: {
          gate: "acceptance",
          status: "pass",
          reason: "Acceptance criteria matched.",
          evidence: ["apps/server/src/index.ts"],
        },
      },
    });
    const recorded = parseToolText(recordResponse);
    assert.equal(recorded.eventType, "gate_record");

    const postedBody = requests[0]?.body as { events: Array<{ type: string; agentName: string; raw: { gate: string; status: string; recordedBy: string } }> };
    assert.equal(postedBody.events[0]?.type, "gate_record");
    assert.equal(postedBody.events[0]?.agentName, "leader");
    assert.equal(postedBody.events[0]?.raw.gate, "acceptance");
    assert.equal(postedBody.events[0]?.raw.status, "pass");
    assert.equal(postedBody.events[0]?.raw.recordedBy, "leader");

    await server.handleRequest({
      id: 12,
      method: "tools/call",
      params: {
        name: "heddle_update_manifest",
        arguments: {
          request: "change setting",
          interpretedGoal: "guard the change",
          riskTier: "side_effect",
          governancePack: "side-effect-guarded",
          workers: ["leader", "reviewer"],
          result: "running",
        },
      },
    });
    await server.handleRequest({
      id: 13,
      method: "tools/call",
      params: {
        name: "heddle_require_approval",
        arguments: {
          gate: "side-effect-boundary",
          target: "guarded setting",
          reason: "Approval required before side effect.",
        },
      },
    });
    await server.handleRequest({
      id: 14,
      method: "tools/call",
      params: {
        name: "heddle_record_approval",
        arguments: {
          gate: "side-effect-boundary",
          status: "approved",
          target: "guarded setting",
          approver: "user",
          approvalText: "Approved.",
        },
      },
    });
    await server.handleRequest({
      id: 15,
      method: "tools/call",
      params: {
        name: "heddle_record_rollback",
        arguments: {
          gate: "side-effect-boundary",
          target: "guarded setting",
          rollbackPlan: "Restore the previous value.",
        },
      },
    });

    const eventTypes = requests
      .map((request) => (request.body as { events?: Array<{ type: string }> } | undefined)?.events?.[0]?.type)
      .filter(Boolean);
    assert.deepEqual(eventTypes, [
      "gate_record",
      "manifest_update",
      "approval_required",
      "approval_recorded",
      "rollback_recorded",
    ]);

    const manifestResponse = await server.handleRequest({
      id: 16,
      method: "tools/call",
      params: {
        name: "heddle_read_manifest",
        arguments: {},
      },
    });
    const manifest = parseToolText(manifestResponse);
    assert.equal((manifest.manifest as { riskTier: string }).riskTier, "side_effect");
    assert.ok(requests.some((request) => request.url.endsWith("/runs/run-1/manifest")));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("governance tools reject invalid arguments before posting events", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const server = new HeddleMcpServer();
    const response = await server.handleRequest({
      id: 17,
      method: "tools/call",
      params: {
        name: "heddle_update_manifest",
        arguments: { riskTier: "danger" },
      },
    });
    assert.equal((response?.error as { code: number }).code, -32000);
    assert.match((response?.error as { message: string }).message, /riskTier must be one of/);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("heddle_record_approval rejects required before posting events", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const server = new HeddleMcpServer();
    const response = await server.handleRequest({
      id: 18,
      method: "tools/call",
      params: {
        name: "heddle_record_approval",
        arguments: {
          status: "required",
          target: "guarded setting",
        },
      },
    });
    assert.equal((response?.error as { code: number }).code, -32000);
    assert.match((response?.error as { message: string }).message, /status must be approved or rejected/);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test("dynamic delegate tools route to their child agent without waiting", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    let delegatedAgent = "";
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
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
        name: "heddle_delegate_reviewer",
        arguments: { briefing: "review the patch", wait: true },
      },
    });

    assert.equal(parseToolText(response).agent, "reviewer");
    assert.equal(parseToolText(response).status, "running");
    assert.equal(delegatedAgent, "reviewer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic delegate tools return task ids without waiting by default", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    let resolveRunner!: (value: RunSubagentTaskResult) => void;
    const runnerPromise = new Promise<RunSubagentTaskResult>((resolve) => {
      resolveRunner = resolve;
    });
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
      },
      delegateRunner: async () => runnerPromise,
    });

    const started = await server.handleRequest({
      id: 4,
      method: "tools/call",
      params: {
        name: "heddle_delegate_reviewer",
        arguments: { briefing: "slow review" },
      },
    });

    const task = parseToolText(started);
    assert.equal(task.agent, "reviewer");
    assert.equal(task.status, "running");
    assert.equal(typeof task.taskId, "string");

    resolveRunner(fakeResult("reviewer"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heddle_delegate returns a task id before the MCP sync wait cap is exceeded", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    let resolveRunner!: (value: RunSubagentTaskResult) => void;
    const runnerPromise = new Promise<RunSubagentTaskResult>((resolve) => {
      resolveRunner = resolve;
    });
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
        HEDDLE_MCP_SYNC_WAIT_CAP_MS: "5",
      },
      delegateRunner: async () => runnerPromise,
    });

    const started = await server.handleRequest({
      id: 5,
      method: "tools/call",
      params: {
        name: "heddle_delegate",
        arguments: {
          agent: "reviewer",
          briefing: "slow review",
          timeoutSeconds: 600,
          wait: true,
        },
      },
    });

    const task = parseToolText(started);
    assert.equal(task.agent, "reviewer");
    assert.equal(task.status, "running");
    assert.equal(task.syncWaitTimedOut, true);
    assert.equal(typeof task.taskId, "string");

    resolveRunner(fakeResult("reviewer"));
    await runnerPromise;
    await new Promise((resolve) => setImmediate(resolve));

    const report = await server.handleRequest({
      id: 6,
      method: "tools/call",
      params: {
        name: "heddle_read_report",
        arguments: { taskId: task.taskId },
      },
    });

    assert.equal(parseToolText(report).status, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heddle_delegate_many applies top-level timeout to tasks without their own timeout", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    const timeouts: number[] = [];
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
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
        name: "heddle_delegate_many",
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

test("heddle_delegate_many returns task ids without waiting for slow children", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    let resolveRunner!: (value: RunSubagentTaskResult) => void;
    const runnerPromise = new Promise<RunSubagentTaskResult>((resolve) => {
      resolveRunner = resolve;
    });
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
      },
      delegateRunner: async () => runnerPromise,
    });

    const responsePromise = server.handleRequest({
      id: 5,
      method: "tools/call",
      params: {
        name: "heddle_delegate_many",
        arguments: {
          tasks: [{ agent: "reviewer", briefing: "slow review" }],
        },
      },
    });
    const raced = await Promise.race([
      responsePromise.then((value) => ({ type: "response" as const, value })),
      new Promise<{ type: "timeout" }>((resolve) => setTimeout(() => resolve({ type: "timeout" }), 25)),
    ]);

    assert.equal(raced.type, "response");
    if (raced.type !== "response") return;
    const started = parseToolText(raced.value);
    assert.equal(started.status, "running");
    assert.equal(started.wait, false);
    const results = started.results as Array<{ taskId: string; agent: string; status: string }>;
    assert.equal(results.length, 1);
    assert.equal(results[0]!.agent, "reviewer");
    assert.equal(results[0]!.status, "running");

    resolveRunner(fakeResult("reviewer"));
    await runnerPromise;
    await new Promise((resolve) => setImmediate(resolve));

    const report = await server.handleRequest({
      id: 6,
      method: "tools/call",
      params: {
        name: "heddle_read_report",
        arguments: { taskId: results[0]!.taskId },
      },
    });

    assert.equal(parseToolText(report).status, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heddle_cancel aborts a running async task", async () => {
  const { root, flowPath } = await createTestFlow();
  try {
    const server = new HeddleMcpServer({
      env: {
        HEDDLE_FLOW_PATH: flowPath,
        HEDDLE_FLOW_CWD: root,
        HEDDLE_AGENT: "leader",
        HEDDLE_SUBAGENT_BIN: "/tmp/heddle-subagent.js",
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
        name: "heddle_delegate",
        arguments: { agent: "reviewer", briefing: "review", wait: false },
      },
    });
    const { taskId } = parseToolText(started);

    const cancelled = await server.handleRequest({
      id: 6,
      method: "tools/call",
      params: {
        name: "heddle_cancel",
        arguments: { taskId },
      },
    });

    assert.equal(parseToolText(cancelled).cancelled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
