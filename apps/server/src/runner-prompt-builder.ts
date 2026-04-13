import type { AgentConfig, FlowDefinition, SkillDefinition } from "@loom/core";
import type { RunResources } from "./runner-resource-loader.js";
import { resolveAgentResources } from "./runner-resource-loader.js";

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
  sections.push(`[Skill: ${skill.name}]${skill.description ? ` — ${skill.description}` : ""}\n${skill.prompt}`);
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
    const children = agent.agents.map((child) => `- name: ${child.name}, type: ${child.type}`);
    sections.push([
      "You can delegate tasks to these agents:",
      ...children,
      "If you need to delegate, respond with exactly one line in this format:",
      "DELEGATE <child-agent-name>: <subtask for the child>",
      "Do not add any extra text when delegating.",
      "If you can finish the task yourself, respond with the final answer normally.",
    ].join("\n"));
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
): AgentConfig {
  return {
    ...agent,
    system:
      agent.parallel && agent.agents?.length
        ? buildParallelChildPrompt(
            buildAgentPrompt(agent, flow, flowRepo, resources),
            agent.agents.map((child) => child.name),
          )
        : buildAgentPrompt(agent, flow, flowRepo, resources),
  };
}
