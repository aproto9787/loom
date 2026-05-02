import type { AgentConfig, RoleDefinition } from "@aproto9787/heddle-core";

export function mergeRoleIntoAgent(agent: AgentConfig, roles: Map<string, RoleDefinition>): AgentConfig {
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
