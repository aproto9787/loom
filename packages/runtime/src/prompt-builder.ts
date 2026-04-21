import type { AgentConfig, FlowDefinition, RoleDefinition, SkillDefinition } from "@loom/core";
import type { RunResources } from "./resource-loader.js";
import { resolveAgentResources } from "./resource-loader.js";

function buildParallelChildPrompt(parentPrompt: string, siblingNames: string[]): string {
  return [
    parentPrompt,
    "",
    `When the task can be split across siblings, delegate independently to any of: ${siblingNames.join(", ")}.`,
    "If you need true sibling concurrency, emit one JSON line with this shape:",
    '{"parallel": [{"childAgent": "name", "reason": "subtask"}]}',
    "Do not use this JSON form for a single child.",
  ].join("\n");
}

function appendSkillPrompt(sections: string[], skill: SkillDefinition): void {
  sections.push(
    `[Skill: ${skill.name}]${skill.description ? ` — ${skill.description}` : ""}\n${skill.prompt}`,
  );
}

function formatDelegation(value: AgentConfig["delegation"]): string {
  if (!value || value.length === 0) {
    return "[]";
  }

  return value.map((entry) => `- to: ${entry.to}\n  when: ${entry.when}`).join("\n");
}

function formatTeams(value: AgentConfig["team"]): string {
  if (!value || value.length === 0) {
    return "[]";
  }

  return value.map((entry) => `- id: ${entry.id}${entry.role ? `\n  role: ${entry.role}` : ""}`).join("\n");
}

function mergeRoleIntoAgent(agent: AgentConfig, roles: Map<string, RoleDefinition>): AgentConfig {
  if (!agent.role) {
    return agent;
  }

  const role = roles.get(agent.role);
  if (!role) {
    return agent;
  }

  return {
    ...role,
    ...agent,
    type: agent.type ?? role.type,
    description: agent.description ?? role.description,
    system: agent.system ?? role.system,
    role: agent.role,
  };
}

export function buildAgentPrompt(
  agent: AgentConfig,
  flow: FlowDefinition,
  flowRepo: string,
  resources: RunResources,
): string {
  const sections: string[] = [];

  if (agent.system?.trim()) {
    sections.push(agent.system.trim());
  }

  const scopedResources = resolveAgentResources(agent, flow);
  for (const skillName of scopedResources.skills) {
    const skill = resources.skills.get(skillName);
    if (skill) {
      appendSkillPrompt(sections, skill);
    }
  }

  sections.push(`Shared flow repo: ${flowRepo}`);

  if (scopedResources.mcps.length) {
    sections.push(`MCP servers available to you: ${scopedResources.mcps.join(", ")}`);
  }

  if (scopedResources.hooks.length) {
    sections.push(`Hook resources available to you: ${scopedResources.hooks.join(", ")}`);
  }

  if (agent.agents?.length) {
    const children = agent.agents.map((child) =>
      [
        `- name: ${child.name}`,
        `  type: ${child.type}`,
        `  team: ${formatTeams(child.team)}`,
        `  delegation: ${formatDelegation(child.delegation)}`,
        `  description: ${child.system?.trim() || ""}`,
      ].join("\n"),
    );

    sections.push(
      [
        "You can delegate tasks to these agents:",
        ...children,
        agent.team?.length
          ? `Team tags for this agent:\n${formatTeams(agent.team)}`
          : "No team tags are configured for this agent.",
        agent.delegation?.length
          ? `Delegation rules for this agent:\n${formatDelegation(agent.delegation)}`
          : "No explicit delegation rules are configured.",
        "First analyze the task, then delegate to the most appropriate child based on the delegation rules, description, role, and team tags.",
        "If you need to delegate, respond with exactly one line in this format:",
        "DELEGATE <child-agent-name>: <brief reason/task>",
        "Do not add any extra text when delegating.",
        "If you can finish the task yourself, respond with the final answer normally.",
      ].join("\n"),
    );
  } else {
    sections.push("No child agents are available. Finish the task yourself.");
  }

  return sections.join("\n\n");
}

export function buildConfiguredAgent(
  agent: AgentConfig,
  flow: FlowDefinition,
  flowRepo: string,
  resources: RunResources,
  roles: Map<string, RoleDefinition> = new Map(),
): AgentConfig {
  const mergedAgent = mergeRoleIntoAgent(agent, roles);
  const mergedChildren = mergedAgent.agents?.map((child) =>
    buildConfiguredAgent(child, flow, flowRepo, resources, roles),
  );
  const basePrompt = buildAgentPrompt(mergedAgent, flow, flowRepo, resources);

  return {
    ...mergedAgent,
    agents: mergedChildren,
    system:
      mergedAgent.parallel && mergedChildren?.length
        ? buildParallelChildPrompt(
            basePrompt,
            mergedChildren.map((child) => child.name),
          )
        : basePrompt,
  };
}
