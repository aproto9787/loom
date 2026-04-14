import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig, FlowDefinition, RoleDefinition } from "@loom/core";
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
  roles: new Map(),
  hooks: new Map(),
  skills: new Map([
    ["brief", { name: "brief", prompt: "Summarize before acting.", description: "team habit" }],
  ]),
};

test("buildAgentPrompt includes resource context and delegation instructions", () => {
  const flowWithClaudeMd: FlowDefinition = {
    ...flow,
    claudeMd: "Flow-wide instruction.",
  };
  const agent: AgentConfig = {
    name: "lead",
    type: "claude-code",
    system: "You are lead.",
    claudeMd: "Agent-specific instruction.",
    delegation: [{ to: "child", when: "When code review is needed." }],
    agents: [{ name: "child", type: "codex", delegation: [{ to: "none", when: "Never" }], system: "Reviews code changes." }],
  };

  const prompt = buildAgentPrompt(agent, flowWithClaudeMd, "/repo", resources);

  assert.match(prompt, /You are lead\./);
  assert.match(prompt, /\[Flow CLAUDE\.md\]\nFlow-wide instruction\./);
  assert.match(prompt, /\[Agent CLAUDE\.md\]\nAgent-specific instruction\./);
  assert.match(prompt, /\[Skill: brief\] — team habit/);
  assert.match(prompt, /Shared flow repo: \/repo/);
  assert.match(prompt, /MCP servers available to you: figma/);
  assert.match(prompt, /Hook resources available to you: boot/);
  assert.match(prompt, /delegation: - to: none/);
  assert.match(prompt, /Delegation rules for this agent:\n- to: child\n  when: When code review is needed\./);
  assert.match(prompt, /description: Reviews code changes\./);
  assert.match(prompt, /First analyze the task, then delegate to the most appropriate child based on the delegation rules/);
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

test("buildConfiguredAgent inherits role system into agent claudeMd when absent", () => {
  const agent: AgentConfig = {
    name: "frontend",
    type: "claude-code",
    role: "frontend-dev",
  };
  const roles: Map<string, RoleDefinition> = new Map([
    [
      "frontend-dev",
      {
        name: "frontend-dev",
        type: "claude-code",
        system: "Build UI.",
        capabilities: ["react", "typescript"],
        isolated: true,
      },
    ],
  ]);

  const configured = buildConfiguredAgent(agent, flow, "/repo", resources, roles);

  assert.equal(configured.claudeMd, "Build UI.");
  assert.equal(configured.isolated, true);
  assert.match(configured.system ?? "", /Build UI\./);
});

test("buildConfiguredAgent lets agent values override role values", () => {
  const agent: AgentConfig = {
    name: "frontend",
    type: "codex",
    role: "frontend-dev",
    system: "Own prompt.",
    claudeMd: "Own claude md.",
    description: "Own description.",
    isolated: false,
  };
  const roles: Map<string, RoleDefinition> = new Map([
    [
      "frontend-dev",
      {
        name: "frontend-dev",
        type: "claude-code",
        system: "Build UI.",
        description: "Role description.",
        capabilities: ["react", "typescript"],
        isolated: true,
      },
    ],
  ]);

  const configured = buildConfiguredAgent(agent, flow, "/repo", resources, roles);

  assert.equal(configured.type, "codex");
  assert.equal(configured.description, "Own description.");
  assert.equal(configured.claudeMd, "Own claude md.");
  assert.equal(configured.isolated, false);
  assert.match(configured.system ?? "", /Own prompt\./);
  assert.doesNotMatch(configured.system ?? "", /Build UI\./);
});
