import { rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { FlowDefinition } from "@aproto9787/loom-core";
import { buildServer } from "./index.js";
import { markStaleRuns, resetTraceStore } from "./trace-store.js";

const DEFAULT_FLOW_PATH = "examples/leader-workers.yaml";
const DEFAULT_FLOW_NAME = "Leader-Workers";

function loomTest(
  name: string,
  fn: (t: TestContext) => Promise<void> | void,
): void {
  void test(name, { concurrency: false }, fn);
}

function createTestApp(t: TestContext) {
  resetTraceStore();
  process.env.LOOM_MOCK = "1";
  process.env.LOOM_SERVER_AUTOSTART = "0";

  const app = buildServer();

  t.after(async () => {
    delete process.env.LOOM_MOCK;
    delete process.env.LOOM_SERVER_AUTOSTART;
    await app.close();
  });

  return app;
}

function parseSseBody(body: string): Array<{ event: string; data: unknown }> {
  return body
    .trim()
    .split("\n\n")
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines
        .find((line) => line.startsWith("event: "))
        ?.slice("event: ".length);
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");

      assert.ok(event);
      return {
        event,
        data: JSON.parse(data) as unknown,
      };
    });
}

function parseSseChunk(chunk: string): { event: string; data: unknown } | null {
  const trimmed = chunk.trim();
  if (!trimmed || trimmed.startsWith(":")) {
    return null;
  }

  const lines = trimmed.split("\n");
  const event = lines
    .find((line) => line.startsWith("event: "))
    ?.slice("event: ".length);
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");

  assert.ok(event);
  return {
    event,
    data: JSON.parse(data) as unknown,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunDetail(
  app: ReturnType<typeof buildServer>,
  runId: string,
  predicate: (body: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await app.inject({
      method: "GET",
      url: `/runs/${runId}`,
    });

    if (response.statusCode === 200) {
      const body = response.json() as Record<string, unknown>;
      if (predicate(body)) {
        return body;
      }
    }

    await sleep(25);
  }

  throw new Error(`timed out waiting for run ${runId}`);
}

async function readRunStreamEvents(
  origin: string,
  runId: string,
  expectedCount: number,
): Promise<{ contentType: string; events: Array<{ event: string; data: unknown }> }> {
  const response = await fetch(`${origin}/runs/${runId}/stream`);
  assert.equal(response.status, 200);

  const contentType = response.headers.get("content-type") ?? "";
  const reader = response.body?.getReader();
  assert.ok(reader);

  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: unknown }> = [];
  let buffer = "";

  while (events.length < expectedCount) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex === -1) {
        break;
      }

      const chunk = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const parsed = parseSseChunk(chunk);
      if (!parsed) {
        continue;
      }

      events.push(parsed);
      if (events.length >= expectedCount) {
        await reader.cancel();
        return { contentType, events };
      }
    }
  }

  await reader.cancel();
  throw new Error(`timed out waiting for ${expectedCount} SSE events from ${runId}`);
}

loomTest("GET /flows lists the leader-workers flow", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "GET",
    url: "/flows",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(body.flows.includes(DEFAULT_FLOW_PATH));
});

loomTest("GET /flows/get loads the leader-workers flow", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "GET",
    url: "/flows/get",
    query: { path: DEFAULT_FLOW_PATH },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.flowPath, DEFAULT_FLOW_PATH);
  assert.equal(body.flow.name, DEFAULT_FLOW_NAME);
  assert.equal(body.flow.repo, ".");
  assert.equal(body.flow.orchestrator.name, "leader");
  assert.equal(body.flow.orchestrator.type, "codex");
});

loomTest("leader-workers routes casual debate prompts through debater agents", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "GET",
    url: "/flows/get",
    query: { path: DEFAULT_FLOW_PATH },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  const flow = body.flow as FlowDefinition;
  const rootLeaderRules = flow.flowMdLibrary?.["root-leader-rules"] ?? "";
  const delegationRules = flow.orchestrator.delegation?.map(({ to, when }) => `${to}: ${when}`) ?? [];

  assert.match(rootLeaderRules, /"토론", "논쟁", "debate", "vs", "비교", "추천", "결정"/);
  assert.match(rootLeaderRules, /토론 후보가 명시되지 않았으면 되묻지 말고/);
  assert.ok(delegationRules.some((rule) => rule.includes("debater-a") && rule.includes("토론/debate/vs")));
  assert.ok(delegationRules.some((rule) => rule.includes("debater-b") && rule.includes("토론/debate/vs")));
  assert.ok(delegationRules.some((rule) => rule.includes("synthesizer") && rule.includes("final answer")));
});

loomTest("leader-workers gates phased work with user-advocate before next phase", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "GET",
    url: "/flows/get",
    query: { path: DEFAULT_FLOW_PATH },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  const flow = body.flow as FlowDefinition;
  const rootLeaderRules = flow.flowMdLibrary?.["root-leader-rules"] ?? "";

  assert.match(rootLeaderRules, /"페이즈", "phase", "단계별", "순차", "roadmap", "milestone"/);
  assert.match(rootLeaderRules, /Phase Loop/);
  assert.match(rootLeaderRules, /user-advocate가 PASS를 반환해야 다음 phase로 넘어간다/);
  assert.match(rootLeaderRules, /user-advocate가 FAIL을 반환하면 다음 phase로 진행하지 않는다/);
  assert.match(rootLeaderRules, /수정-검증 루프를 반복한다/);
});

loomTest("POST /runs accepts the current flow and persists the mocked local CLI run", async (t) => {
  const app = createTestApp(t);
  const userPrompt = "Inspect the local-only runtime path";

  const response = await app.inject({
    method: "POST",
    url: "/runs",
    payload: {
      flowPath: DEFAULT_FLOW_PATH,
      userPrompt,
    },
  });

  assert.equal(response.statusCode, 202);
  const body = response.json();
  assert.equal(body.flowName, DEFAULT_FLOW_NAME);
  assert.equal(body.status, "running");
  assert.equal(body.source, "server");
  assert.equal(typeof body.runId, "string");

  const detailBody = await waitForRunDetail(
    app,
    body.runId as string,
    (run) => run.status === "done",
  );
  assert.equal(detailBody.flowName, DEFAULT_FLOW_NAME);
  assert.equal(detailBody.flowPath, DEFAULT_FLOW_PATH);
  assert.equal(detailBody.userPrompt, userPrompt);
  assert.equal(detailBody.status, "done");
  assert.equal(detailBody.exitCode, 0);
  assert.equal(detailBody.source, "server");
});

loomTest("GET /runs/:id returns 404 for a missing run", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "GET",
    url: "/runs/missing-run-id",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: { message: "run not found" } });
});

loomTest("runs register, batched events, stale transitions, and per-run SSE work together", async (t) => {
  const app = createTestApp(t);
  const runId = "run-events-smoke";
  const now = Date.now();
  const staleStart = new Date(now - (11 * 60 * 1000)).toISOString();
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });

  const registerResponse = await app.inject({
    method: "POST",
    url: "/runs/register",
    payload: {
      runId,
      flowPath: DEFAULT_FLOW_PATH,
      flowName: DEFAULT_FLOW_NAME,
      agentType: "claude-code",
      startTime: new Date(now).toISOString(),
      source: "cli",
      cwd: "/tmp/workspace",
    },
  });

  assert.equal(registerResponse.statusCode, 201);
  assert.deepEqual(registerResponse.json(), { runId });

  const secondRegisterResponse = await app.inject({
    method: "POST",
    url: "/runs/register",
    payload: {
      runId,
      flowPath: DEFAULT_FLOW_PATH,
      flowName: DEFAULT_FLOW_NAME,
      agentType: "claude-code",
      startTime: new Date(now).toISOString(),
      source: "cli",
      cwd: "/tmp/workspace",
    },
  });
  assert.equal(secondRegisterResponse.statusCode, 200);
  assert.deepEqual(secondRegisterResponse.json(), { runId });

  const staleRegisterResponse = await app.inject({
    method: "POST",
    url: "/runs/register",
    payload: {
      runId: "stale-run",
      flowPath: DEFAULT_FLOW_PATH,
      flowName: "Stale Flow",
      agentType: "claude-code",
      startTime: staleStart,
      source: "cli",
    },
  });
  assert.equal(staleRegisterResponse.statusCode, 201);

  const ssePromise = readRunStreamEvents(origin, runId, 2);

  await sleep(25);

  const eventsPostResponse = await app.inject({
    method: "POST",
    url: `/runs/${runId}/events`,
    payload: {
      events: [
        {
          ts: now + 2000,
          type: "assistant",
          summary: "assistant reply",
          agentName: "leader",
          raw: { text: "world" },
        },
        {
          ts: now + 1000,
          type: "user",
          summary: "user prompt",
          raw: { text: "hello" },
        },
      ],
    },
  });
  assert.equal(eventsPostResponse.statusCode, 201);
  assert.deepEqual(eventsPostResponse.json(), { runId, count: 2 });

  const eventsResponse = await app.inject({
    method: "GET",
    url: `/runs/${runId}/events`,
  });
  assert.equal(eventsResponse.statusCode, 200);
  const eventsBody = eventsResponse.json();
  assert.equal(eventsBody.runId, runId);
  assert.equal(eventsBody.events.length, 2);
  assert.deepEqual(eventsBody.events.map((event: { ts: number }) => event.ts), [now + 1000, now + 2000]);
  assert.equal(eventsBody.events[0].type, "user");
  assert.equal(eventsBody.events[1].type, "assistant");

  const listResponse = await app.inject({
    method: "GET",
    url: "/runs?page=1&pageSize=10",
  });
  assert.equal(listResponse.statusCode, 200);
  const listBody = listResponse.json();
  const staleRun = listBody.runs.find((run: { runId: string }) => run.runId === "stale-run");
  assert.ok(staleRun);
  assert.equal(staleRun.status, "stale");

  const detailResponse = await app.inject({
    method: "GET",
    url: `/runs/${runId}`,
  });
  assert.equal(detailResponse.statusCode, 200);
  const detailBody = detailResponse.json();
  assert.equal(detailBody.cwd, "/tmp/workspace");
  assert.equal(detailBody.flowPath, DEFAULT_FLOW_PATH);

  const sseResponse = await Promise.race([
    ssePromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for SSE stream")), 1000)),
  ]);
  assert.match(sseResponse.contentType, /^text\/event-stream/);
  const sseEvents = sseResponse.events;
  assert.equal(sseEvents.length, 2);
  assert.deepEqual(sseEvents.map((event) => event.event), ["run_event", "run_event"]);
  assert.deepEqual((sseEvents[0]?.data as { ts: number }).ts, now + 2000);
  assert.deepEqual((sseEvents[1]?.data as { ts: number }).ts, now + 1000);

  assert.equal(markStaleRuns(now + (11 * 60 * 1000)), 1);
});

loomTest("POST /runs/:id/abort returns 404 when the run does not exist", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "POST",
    url: "/runs/missing-run-id/abort",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: { message: "run not found" } });
});

loomTest("Oracle advisor endpoints expose optional status and persist unavailable runs", async (t) => {
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const app = createTestApp(t);

  const statusResponse = await app.inject({
    method: "GET",
    url: "/plugins/oracle/status",
  });

  assert.equal(statusResponse.statusCode, 200);
  const statusBody = statusResponse.json();
  assert.equal(statusBody.oracle.available, false);
  assert.equal(statusBody.oracleMcp.available, false);
  assert.equal(statusBody.plugin.id, "oracle");
  assert.equal(statusBody.attribution, "Oracle by steipete");

  const runResponse = await app.inject({
    method: "POST",
    url: "/plugins/oracle/run",
    payload: {
      prompt: "review advisor connector",
      files: ["packages/mcp/src/**/*.ts"],
      args: ["--dry-run", "summary"],
      useNpxFallback: false,
    },
  });

  assert.equal(runResponse.statusCode, 200);
  const runBody = runResponse.json();
  assert.equal(runBody.result.status, "unavailable");
  assert.equal(runBody.result.attribution, "Oracle by steipete");
  assert.equal(typeof runBody.runId, "string");

  const eventsResponse = await app.inject({
    method: "GET",
    url: `/runs/${runBody.runId}/events`,
  });
  assert.equal(eventsResponse.statusCode, 200);
  const eventsBody = eventsResponse.json();
  assert.deepEqual(eventsBody.events.map((event: { type: string }) => event.type), ["tool_use", "tool_result"]);
  assert.deepEqual(eventsBody.events.map((event: { toolName: string }) => event.toolName), ["loom_oracle", "loom_oracle"]);

  const detailResponse = await app.inject({
    method: "GET",
    url: `/runs/${runBody.runId}`,
  });
  assert.equal(detailResponse.statusCode, 200);
  assert.equal(detailResponse.json().status, "error");
});

loomTest("PUT /flows/save round-trips the current recursive flow through YAML", async (t) => {
  const app = createTestApp(t);
  const flowPath = "examples/_roundtrip.yaml";

  t.after(async () => {
    await rm(new URL("../../../examples/_roundtrip.yaml", import.meta.url), { force: true });
  });

  const originalResponse = await app.inject({
    method: "GET",
    url: "/flows/get",
    query: { path: DEFAULT_FLOW_PATH },
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
  assert.deepEqual(loadedResponse.json(), {
    flowPath,
    flow: originalBody.flow,
  });
});

loomTest("PUT /flows/save rejects invalid recursive flow bodies and bad paths", async (t) => {
  const app = createTestApp(t);

  const invalidSchemaResponse = await app.inject({
    method: "PUT",
    url: "/flows/save",
    payload: {
      flowPath: "examples/invalid.yaml",
      flow: {
        name: "Broken Flow",
        repo: "",
        orchestrator: {
          name: "",
          type: "claude-code",
        },
      },
    },
  });

  assert.equal(invalidSchemaResponse.statusCode, 400);
  const invalidSchemaBody = invalidSchemaResponse.json();
  assert.ok(Array.isArray(invalidSchemaBody.error.formErrors));
  assert.ok(invalidSchemaBody.error.fieldErrors);

  const validFlow: FlowDefinition = {
    name: "Valid Saved Flow",
    repo: ".",
    orchestrator: {
      name: "leader",
      type: "claude-code",
    },
  };

  const escapedPathResponse = await app.inject({
    method: "PUT",
    url: "/flows/save",
    payload: {
      flowPath: "../../etc/passwd",
      flow: validFlow,
    },
  });

  assert.equal(escapedPathResponse.statusCode, 400);
  assert.match(JSON.stringify(escapedPathResponse.json().error), /examples\//);

  const nonYamlResponse = await app.inject({
    method: "PUT",
    url: "/flows/save",
    payload: {
      flowPath: "examples/not-yaml.txt",
      flow: validFlow,
    },
  });

  assert.equal(nonYamlResponse.statusCode, 400);
  assert.match(JSON.stringify(nonYamlResponse.json().error), /\.yaml/);
});
