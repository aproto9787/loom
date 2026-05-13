import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentConfig, FlowDefinition } from "@aproto9787/heddle-core";
import { createScopedMcpConfig, resolveAgentResources } from "./runner-resource-loader.js";

test("resolveAgentResources merges flow and agent resources without duplicates", () => {
  const flow: FlowDefinition = {
    name: "demo",
    repo: ".",
    orchestrator: { name: "lead", type: "codex" },
    resources: {
      mcps: ["shared", "flow"],
      hooks: ["boot"],
      skills: ["summarize"],
    },
  };
  const agent: AgentConfig = {
    name: "child",
    type: "codex",
    mcps: ["shared", "agent"],
    hooks: ["boot", "deploy"],
    skills: ["summarize", "lint"],
  };

  assert.deepEqual(resolveAgentResources(agent, flow), {
    mcps: ["shared", "flow", "agent"],
    hooks: ["boot", "deploy"],
    skills: ["summarize", "lint"],
  });
});

test("createScopedMcpConfig writes a filtered config for requested workspace servers", async () => {
  const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), "heddle-workspace-"));
  await writeFile(
    path.join(tempWorkspace, ".mcp.json"),
    JSON.stringify({ mcpServers: { alpha: { command: "a" }, beta: { command: "b" } } }),
    "utf8",
  );

  const flow: FlowDefinition = {
    name: "demo",
    repo: ".",
    orchestrator: { name: "lead", type: "codex" },
  };
  const agent: AgentConfig = {
    name: "child",
    type: "codex",
    mcps: ["beta"],
  };

  try {
    const configPath = await createScopedMcpConfig(agent, flow, undefined, { workspaceRoot: tempWorkspace });
    assert.ok(configPath);
    const raw = await readFile(configPath, "utf8");
    assert.deepEqual(JSON.parse(raw), { mcpServers: { beta: { command: "b" } } });
    await rm(path.dirname(configPath), { recursive: true, force: true });
  } finally {
    await rm(tempWorkspace, { recursive: true, force: true });
  }
});

test("createScopedMcpConfig reads workspace MCP config for requested servers", async () => {
  const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), "heddle-workspace-"));
  await writeFile(
    path.join(tempWorkspace, ".mcp.json"),
    JSON.stringify({ mcpServers: { alpha: { command: "a" } } }),
    "utf8",
  );

  const flow: FlowDefinition = {
    name: "demo",
    repo: ".",
    orchestrator: { name: "lead", type: "codex" },
  };
  const agent: AgentConfig = {
    name: "child",
    type: "codex",
    mcps: ["alpha"],
  };

  try {
    const configPath = await createScopedMcpConfig(agent, flow, undefined, { workspaceRoot: tempWorkspace });
    assert.ok(configPath);
    const raw = await readFile(configPath, "utf8");
    assert.deepEqual(JSON.parse(raw), { mcpServers: { alpha: { command: "a" } } });
    await rm(path.dirname(configPath), { recursive: true, force: true });
  } finally {
    await rm(tempWorkspace, { recursive: true, force: true });
  }
});

test("createScopedMcpConfig warns when a config source cannot be parsed", async () => {
  const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), "heddle-workspace-"));
  const errors: string[] = [];
  const originalWarn = console.warn;
  await mkdir(path.join(tempWorkspace), { recursive: true });
  await writeFile(path.join(tempWorkspace, ".mcp.json"), "not json", "utf8");
  console.warn = (message: string) => {
    errors.push(message);
  };

  const flow: FlowDefinition = {
    name: "demo",
    repo: ".",
    orchestrator: { name: "lead", type: "codex" },
  };
  const agent: AgentConfig = {
    name: "child",
    type: "codex",
    mcps: ["alpha"],
  };

  try {
    const configPath = await createScopedMcpConfig(agent, flow, undefined, { workspaceRoot: tempWorkspace });
    assert.equal(configPath, undefined);
    assert.ok(errors.length >= 1);
    assert.ok(errors.every((message) => /Failed to read MCP config/.test(message)));
  } finally {
    console.warn = originalWarn;
    await rm(tempWorkspace, { recursive: true, force: true });
  }
});
