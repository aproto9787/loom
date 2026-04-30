import type { AgentConfig, SkillDefinition } from "@aproto9787/loom-core";

export function buildParallelChildPrompt(parentPrompt: string, siblingNames: string[]): string {
  return [
    parentPrompt,
    "",
    `Parallel hint: if this task should be split, use Loom MCP delegation tools for: ${siblingNames.join(", ")}.`,
    "Do not emit DELEGATE lines or JSON delegation directives.",
  ].join("\n");
}

export function appendSkillPrompt(sections: string[], skill: SkillDefinition): void {
  sections.push(
    `[Skill: ${skill.name}]${skill.description ? ` — ${skill.description}` : ""}\n${skill.prompt}`,
  );
}

export function formatDelegation(value: AgentConfig["delegation"]): string {
  if (!value || value.length === 0) {
    return "[]";
  }

  return value.map((entry) => `- to: ${entry.to}\n  when: ${entry.when}`).join("\n");
}

export function formatTeams(value: AgentConfig["team"]): string {
  if (!value || value.length === 0) {
    return "[]";
  }

  return value.map((entry) => `- id: ${entry.id}${entry.role ? `\n  role: ${entry.role}` : ""}`).join("\n");
}
