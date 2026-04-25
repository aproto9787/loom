import type { AgentConfig, AgentRuntimeConfig } from "@loom/core";

export function isAgentEnabled(agent: AgentConfig): boolean {
  return agent.enabled !== false;
}

export function directChildren(agent: AgentConfig): AgentConfig[] {
  return (agent.agents ?? []).filter(isAgentEnabled);
}

export function findAgentByName(root: AgentConfig, name: string): AgentConfig | undefined {
  if (root.name === name) return root;
  for (const child of root.agents ?? []) {
    const found = findAgentByName(child, name);
    if (found) return found;
  }
  return undefined;
}

export function findParentAgent(root: AgentConfig, childName: string): AgentConfig | undefined {
  for (const child of root.agents ?? []) {
    if (child.name === childName) {
      return root;
    }
    const nested = findParentAgent(child, childName);
    if (nested) return nested;
  }
  return undefined;
}

export function resolveAgentRuntime(agent: AgentConfig, isRoot: boolean): Required<AgentRuntimeConfig> {
  return {
    mode: agent.runtime?.mode ?? (isRoot ? "host" : "isolated"),
    profile: agent.runtime?.profile ?? `${agent.type === "codex" ? "codex" : "claude"}-default`,
    applyResources: agent.runtime?.applyResources ?? (isRoot ? "prompt-only" : "scoped-home"),
    delegationTransport: agent.runtime?.delegationTransport ?? (isRoot ? "mcp" : "bash"),
  };
}
