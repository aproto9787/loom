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
  const agent: AgentConfig = {
    name: "lead",
    type: "claude-code",
    system: "You are lead.",
    delegation: [{ to: "child", when: "When code review is needed." }],
    agents: [{ name: "child", type: "codex", delegation: [{ to: "none", when: "Never" }], system: "Reviews code changes." }],
  };

  const prompt = buildAgentPrompt(agent, flow, "/repo", resources);

  assert.match(prompt, /You are lead\./);
  assert.match(prompt, /\[Skill: brief\] — team habit/);
  assert.match(prompt, /Shared flow repo: \/repo/);
  assert.match(prompt, /MCP servers available to you: figma/);
  assert.match(prompt, /Hook resources available to you: boot/);
  assert.match(prompt, /delegation: - to: none/);
  assert.match(prompt, /Delegation rules for this agent:\n- to: child\n  when: When code review is needed\./);
  assert.match(prompt, /description: Reviews code changes\./);
  assert.match(prompt, /Use this child-agent metadata as planning guidance only\./);
  assert.match(prompt, /Actual child-agent launch mechanics are injected by the Loom Delegation Protocol\./);
  assert.match(prompt, /If the user explicitly asks to delegate, assign work, use workers\/agents\/team members, or parallelize/);
  assert.match(prompt, /Do not emit DELEGATE lines or JSON delegation directives\./);
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
  assert.match(configured.system, /Parallel hint: if this task should be split, use Loom MCP delegation tools for:/);
  assert.match(configured.system, /child-a, child-b/);
});

test("buildConfiguredAgent inherits role defaults when agent fields are absent", () => {
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
        description: "Role description.",
      },
    ],
  ]);

  const configured = buildConfiguredAgent(agent, flow, "/repo", resources, roles);

  assert.equal(configured.description, "Role description.");
  assert.match(configured.system ?? "", /Build UI\./);
});

test("buildConfiguredAgent lets agent values override role values", () => {
  const agent: AgentConfig = {
    name: "frontend",
    type: "codex",
    role: "frontend-dev",
    system: "Own prompt.",
    description: "Own description.",
  };
  const roles: Map<string, RoleDefinition> = new Map([
    [
      "frontend-dev",
      {
        name: "frontend-dev",
        type: "claude-code",
        system: "Build UI.",
        description: "Role description.",
      },
    ],
  ]);

  const configured = buildConfiguredAgent(agent, flow, "/repo", resources, roles);

  assert.equal(configured.type, "codex");
  assert.equal(configured.description, "Own description.");
  assert.match(configured.system ?? "", /Own prompt\./);
  assert.doesNotMatch(configured.system ?? "", /Build UI\./);
});
