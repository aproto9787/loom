import type { AgentConfig, FlowDefinition } from "@loom/core";

const VALID_AGENT_TYPES = new Set(["claude-code", "codex"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateAgentConfig(agent: AgentConfig, path = "agent"): string[] {
  const errors: string[] = [];

  if (!isNonEmptyString(agent.name)) {
    errors.push(`[${path}.name] name is required`);
  }

  if (!VALID_AGENT_TYPES.has(agent.type)) {
    errors.push(`[${path}.type] type must be one of: claude-code, codex`);
  }

  if (agent.repo !== undefined && !isNonEmptyString(agent.repo)) {
    errors.push(`[${path}.repo] repo must be a non-empty string when provided`);
  }

  if (agent.system !== undefined && !isNonEmptyString(agent.system)) {
    errors.push(`[${path}.system] system must be a non-empty string when provided`);
  }

  if (agent.agents === undefined) {
    return errors;
  }

  if (!Array.isArray(agent.agents)) {
    errors.push(`[${path}.agents] agents must be an array when provided`);
    return errors;
  }

  agent.agents.forEach((child, index) => {
    errors.push(...validateAgentConfig(child, `${path}.agents.${index}`));
  });

  return errors;
}

export function validateFlow(flow: FlowDefinition): string[] {
  const errors: string[] = [];

  if (!isNonEmptyString(flow.name)) {
    errors.push("[flow.name] name is required");
  }

  if (flow.description !== undefined && !isNonEmptyString(flow.description)) {
    errors.push("[flow.description] description must be a non-empty string when provided");
  }

  if (!flow.orchestrator) {
    errors.push("[flow.orchestrator] orchestrator is required");
    return errors;
  }

  errors.push(...validateAgentConfig(flow.orchestrator, "orchestrator"));
  return errors;
}
