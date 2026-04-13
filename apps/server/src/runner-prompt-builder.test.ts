import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig, FlowDefinition } from "@loom/core";
import { buildAgentPrompt, buildConfiguredAgent } from "./runner-prompt-builder.js";
import type { RunResources } from "./runner-resource-loader.js";

const flow: FlowDefinition = {
  name: "demo",
  repo: ".",
  orchestrator: { name: "lead", type: "claude-code" },
  resources: {
    mcps: ["figma"],
    hooks: ["boot"],
    skills: ["brief"],
  },
};

const resources: RunResources = {
  hooks: new Map(),
  skills: new Map([
    ["brief", { name: "brief", prompt: "Summarize before acting.", description: "team habit" }],
  ]),
};

test("buildAgentPrompt includes resource context and delegation instructions", () => {
  const agent: AgentConfig = {
    name: "lead",
    type: "claude-code",
    system: "You are lead.",
    agents: [{ name: "child", type: "codex" }],
  };

  const prompt = buildAgentPrompt(agent, flow, "/repo", resources);

  assert.match(prompt, /You are lead\./);
  assert.match(prompt, /\[Skill: brief\] — team habit/);
  assert.match(prompt, /Shared flow repo: \/repo/);
  assert.match(prompt, /MCP servers available to you: figma/);
  assert.match(prompt, /Hook resources available to you: boot/);
  assert.match(prompt, /DELEGATE <child-agent-name>:/);
});

test("buildConfiguredAgent adds parallel child guidance when parallel is enabled", () => {
  const agent: AgentConfig = {
    name: "lead",
    type: "claude-code",
    parallel: true,
    agents: [
      { name: "child-a", type: "claude-code" },
      { name: "child-b", type: "codex" },
    ],
  };

  const configured = buildConfiguredAgent(agent, flow, "/repo", resources);
  assert.ok(configured.system);
  assert.match(configured.system, /When the task can be split across siblings/);
  assert.match(configured.system, /child-a, child-b/);
});
