import { rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { FlowDefinition } from "@loom/core";
import { buildServer } from "./index.js";
import { resetTraceStore } from "./trace-store.js";

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

loomTest("GET /flows lists only recursive orchestration examples", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "GET",
    url: "/flows",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    flows: [
      "examples/multi-repo.yaml",
      "examples/nested.yaml",
      "examples/simple.yaml",
    ],
  });
});

loomTest("GET /flows/get parses a nested recursive flow definition", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "GET",
    url: "/flows/get",
    query: { path: "examples/nested.yaml" },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.flowPath, "examples/nested.yaml");
  assert.equal(body.flow.name, "Nested Agent Orchestration");
  assert.equal(body.flow.orchestrator.name, "lead");
  assert.equal(body.flow.orchestrator.agents[0].name, "backend-lead");
  assert.equal(body.flow.orchestrator.agents[0].agents[0].name, "database-specialist");
  assert.equal(body.flow.orchestrator.agents[1].name, "qa");
});

loomTest("POST /runs returns a mock RunResponse for the new flow format", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "POST",
    url: "/runs",
    payload: {
      flowPath: "examples/simple.yaml",
      userPrompt: "Plan the recursive orchestration refactor",
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.flowName, "Simple Agent Orchestration");
  assert.equal(typeof body.runId, "string");
  assert.equal(
    body.output,
    "Mock Claude Code response from lead: Plan the recursive orchestration refactor",
  );
  assert.deepEqual(body.agentResults, [
    {
      agentName: "lead",
      output: "Mock Claude Code response from lead: Plan the recursive orchestration refactor",
      startedAt: body.agentResults[0].startedAt,
      finishedAt: body.agentResults[0].finishedAt,
    },
  ]);
  assert.equal(typeof body.agentResults[0].startedAt, "string");
  assert.equal(typeof body.agentResults[0].finishedAt, "string");
});

loomTest("POST /runs/stream emits SSE lifecycle events for the orchestrator", async (t) => {
  const app = createTestApp(t);

  const response = await app.inject({
    method: "POST",
    url: "/runs/stream",
    payload: {
      flowPath: "examples/simple.yaml",
      userPrompt: "Stream the lead agent response",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /^text\/event-stream/);

  const events = parseSseBody(response.body);
  const eventTypes = events.map((event) => event.event);

  assert.deepEqual(eventTypes[0], "run_start");
  assert.ok(eventTypes.includes("agent_start"));
  assert.ok(eventTypes.includes("agent_token"));
  assert.ok(eventTypes.includes("agent_complete"));
  assert.deepEqual(eventTypes.at(-1), "run_complete");

  const runStart = events[0]?.data as { runId: string; flowName: string };
  assert.equal(runStart.flowName, "Simple Agent Orchestration");
  assert.equal(typeof runStart.runId, "string");

  const agentStart = events.find((event) => event.event === "agent_start")?.data as {
    agentName: string;
    agentType: string;
  };
  assert.deepEqual(agentStart, {
    agentName: "lead",
    agentType: "claude-code",
  });

  const agentComplete = events.find((event) => event.event === "agent_complete")?.data as {
    agentName: string;
    output: string;
  };
  assert.deepEqual(agentComplete, {
    agentName: "lead",
    output: "Mock Claude Code response from lead: Stream the lead agent response",
  });

  const runComplete = events.at(-1)?.data as { output: string };
  assert.equal(runComplete.output, "Mock Claude Code response from lead: Stream the lead agent response");
});

loomTest("GET /runs and GET /runs/:id return persisted runs from streamed executions", async (t) => {
  const app = createTestApp(t);

  const streamResponse = await app.inject({
    method: "POST",
    url: "/runs/stream",
    payload: {
      flowPath: "examples/multi-repo.yaml",
      userPrompt: "Coordinate work across repos",
    },
  });

  assert.equal(streamResponse.statusCode, 200);
  const streamEvents = parseSseBody(streamResponse.body);
  const runStart = streamEvents.find((event) => event.event === "run_start")?.data as {
    runId: string;
    flowName: string;
  };

  const listResponse = await app.inject({
    method: "GET",
    url: "/runs?page=1&pageSize=10",
  });

  assert.equal(listResponse.statusCode, 200);
  const listBody = listResponse.json();
  assert.equal(listBody.page, 1);
  assert.equal(listBody.pageSize, 10);
  assert.equal(listBody.runs.length, 1);
  assert.deepEqual(listBody.runs[0], {
    runId: runStart.runId,
    flowName: "Multi Repo Agent Orchestration",
    createdAt: listBody.runs[0].createdAt,
    agentCount: 1,
  });
  assert.equal(typeof listBody.runs[0].createdAt, "string");

  const detailResponse = await app.inject({
    method: "GET",
    url: `/runs/${runStart.runId}`,
  });

  assert.equal(detailResponse.statusCode, 200);
  const detailBody = detailResponse.json();
  assert.equal(detailBody.runId, runStart.runId);
  assert.equal(detailBody.flowName, "Multi Repo Agent Orchestration");
  assert.equal(detailBody.flowPath, "examples/multi-repo.yaml");
  assert.equal(detailBody.userPrompt, "Coordinate work across repos");
  assert.equal(
    detailBody.output,
    "Mock Claude Code response from coordinator: Coordinate work across repos",
  );
  assert.equal(detailBody.agentResults.length, 1);
  assert.deepEqual(detailBody.agentResults[0], {
    agentName: "coordinator",
    output: "Mock Claude Code response from coordinator: Coordinate work across repos",
    startedAt: detailBody.agentResults[0].startedAt,
    finishedAt: detailBody.agentResults[0].finishedAt,
    createdAt: detailBody.agentResults[0].createdAt,
  });
  assert.equal(typeof detailBody.agentResults[0].startedAt, "string");
  assert.equal(typeof detailBody.agentResults[0].finishedAt, "string");
  assert.equal(typeof detailBody.agentResults[0].createdAt, "string");
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

loomTest("PUT /flows/save round-trips a recursive flow through YAML", async (t) => {
  const app = createTestApp(t);
  const flowPath = "examples/_roundtrip.yaml";

  t.after(async () => {
    await rm(new URL("../../../examples/_roundtrip.yaml", import.meta.url), { force: true });
  });

  const originalResponse = await app.inject({
    method: "GET",
    url: "/flows/get",
    query: { path: "examples/simple.yaml" },
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
    orchestrator: {
      name: "lead",
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
