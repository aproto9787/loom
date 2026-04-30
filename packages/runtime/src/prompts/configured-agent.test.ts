import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentConfig,
  FlowDefinition,
  RoleDefinition,
} from "@aproto9787/loom-core";
import type { RunResources } from "../resources/index.js";
import { buildConfiguredAgent } from "./configured-agent.js";

function runResourcesWithRoles(roles: Map<string, RoleDefinition>): RunResources {
  return {
    roles,
    hooks: new Map(),
    skills: new Map(),
  };
}

test("buildConfiguredAgent uses loaded resource roles by default", () => {
  const agent: AgentConfig = {
    name: "reviewer",
    type: "codex",
    role: "code-reviewer",
  };
  const flow: FlowDefinition = {
    name: "Role-backed flow",
    repo: ".",
    orchestrator: agent,
  };
  const resources = runResourcesWithRoles(new Map([
    [
      "code-reviewer",
      {
        name: "code-reviewer",
        type: "codex",
        model: "gpt-5.5",
        system: "Review the assigned code and report concrete findings.",
        effort: "high",
        description: "Checks behavior and regressions.",
      },
    ],
  ]));

  const configured = buildConfiguredAgent(agent, flow, flow.repo, resources);

  assert.equal(configured.model, "gpt-5.5");
  assert.equal(configured.effort, "high");
  assert.equal(configured.description, "Checks behavior and regressions.");
  assert.match(
    configured.system ?? "",
    /Review the assigned code and report concrete findings\./,
  );
});

test("buildConfiguredAgent still lets agent fields override role defaults", () => {
  const agent: AgentConfig = {
    name: "reviewer",
    type: "codex",
    role: "code-reviewer",
    model: "gpt-5.5-mini",
    system: "Use the agent-specific review instructions.",
  };
  const flow: FlowDefinition = {
    name: "Override flow",
    repo: ".",
    orchestrator: agent,
  };
  const resources = runResourcesWithRoles(new Map([
    [
      "code-reviewer",
      {
        name: "code-reviewer",
        type: "codex",
        model: "gpt-5.5",
        system: "Use the role review instructions.",
      },
    ],
  ]));

  const configured = buildConfiguredAgent(agent, flow, flow.repo, resources);

  assert.equal(configured.model, "gpt-5.5-mini");
  assert.match(configured.system ?? "", /Use the agent-specific review instructions\./);
  assert.doesNotMatch(configured.system ?? "", /Use the role review instructions\./);
});
