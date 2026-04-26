import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentConfig, FlowDefinition } from "@aproto9787/loom-core";
import { createScopedMcpConfig, resolveAgentResources } from "./runner-resource-loader.js";

test("resolveAgentResources merges flow and agent resources without duplicates", () => {
  const flow: FlowDefinition = {
    name: "demo",
    repo: ".",
    orchestrator: { name: "lead", type: "claude-code" },
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

test("createScopedMcpConfig writes a filtered config for requested servers", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "loom-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  await writeFile(
    path.join(tempHome, ".claude.json"),
    JSON.stringify({ mcpServers: { alpha: { command: "a" }, beta: { command: "b" } } }),
    "utf8",
  );

  const flow: FlowDefinition = {
    name: "demo",
    repo: ".",
    orchestrator: { name: "lead", type: "claude-code" },
  };
  const agent: AgentConfig = {
    name: "child",
    type: "claude-code",
    mcps: ["beta"],
  };

  try {
    const configPath = await createScopedMcpConfig(agent, flow, tempHome);
    assert.ok(configPath);
    const raw = await readFile(configPath, "utf8");
    assert.deepEqual(JSON.parse(raw), { mcpServers: { beta: { command: "b" } } });
    await rm(path.dirname(configPath), { recursive: true, force: true });
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("createScopedMcpConfig reads home MCP config for requested servers", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "loom-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  await writeFile(
    path.join(tempHome, ".claude.json"),
    JSON.stringify({ mcpServers: { alpha: { command: "a" } } }),
    "utf8",
  );

  const flow: FlowDefinition = {
    name: "demo",
    repo: ".",
    orchestrator: { name: "lead", type: "claude-code" },
  };
  const agent: AgentConfig = {
    name: "child",
    type: "claude-code",
    mcps: ["alpha"],
  };

  try {
    const configPath = await createScopedMcpConfig(agent, flow, tempHome);
    assert.ok(configPath);
    const raw = await readFile(configPath, "utf8");
    assert.deepEqual(JSON.parse(raw), { mcpServers: { alpha: { command: "a" } } });
    await rm(path.dirname(configPath), { recursive: true, force: true });
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("createScopedMcpConfig warns when a config source cannot be parsed", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "loom-home-"));
  const originalHome = process.env.HOME;
  const errors: string[] = [];
  const originalWarn = console.warn;
  process.env.HOME = tempHome;
  await mkdir(path.join(tempHome), { recursive: true });
  await writeFile(path.join(tempHome, ".claude.json"), "not json", "utf8");
  console.warn = (message: string) => {
    errors.push(message);
  };

  const flow: FlowDefinition = {
    name: "demo",
    repo: ".",
    orchestrator: { name: "lead", type: "claude-code" },
  };
  const agent: AgentConfig = {
    name: "child",
    type: "claude-code",
    mcps: ["alpha"],
  };

  try {
    const configPath = await createScopedMcpConfig(agent, flow, tempHome);
    assert.equal(configPath, undefined);
    assert.ok(errors.length >= 1);
    assert.ok(errors.every((message) => /Failed to read MCP config/.test(message)));
  } finally {
    console.warn = originalWarn;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
});
