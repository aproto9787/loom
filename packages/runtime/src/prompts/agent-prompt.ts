import type { AgentConfig, FlowDefinition } from "@aproto9787/loom-core";
import { directChildren } from "../agent-tree.js";
import { resolveAgentResources } from "../resources/index.js";
import type { RunResources } from "../resources/index.js";
import { appendSkillPrompt, formatDelegation, formatTeams } from "./format.js";

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

  const children = directChildren(agent);
  if (children.length) {
    const childDescriptions = children.map((child) =>
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
        ...childDescriptions,
        agent.team?.length
          ? `Team tags for this agent:\n${formatTeams(agent.team)}`
          : "No team tags are configured for this agent.",
        agent.delegation?.length
          ? `Delegation rules for this agent:\n${formatDelegation(agent.delegation)}`
          : "No explicit delegation rules are configured.",
        "Use this child-agent metadata as planning guidance only.",
        "Actual child-agent launch mechanics are injected by the Loom Delegation Protocol.",
        "If the user explicitly asks to delegate, assign work, use workers/agents/team members, or parallelize, delegate the relevant non-trivial work instead of completing the whole task yourself.",
        "Do not emit DELEGATE lines or JSON delegation directives.",
        "If you can finish the task yourself, respond with the final answer normally.",
      ].join("\n"),
    );
  } else {
    sections.push("No child agents are available. Finish the task yourself.");
  }

  return sections.join("\n\n");
}
