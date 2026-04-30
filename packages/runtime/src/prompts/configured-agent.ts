import type { AgentConfig, FlowDefinition, RoleDefinition } from "@aproto9787/loom-core";
import type { RunResources } from "../resources/index.js";
import { buildAgentPrompt } from "./agent-prompt.js";
import { buildParallelChildPrompt } from "./format.js";
import { mergeRoleIntoAgent } from "./roles.js";

export function buildConfiguredAgent(
  agent: AgentConfig,
  flow: FlowDefinition,
  flowRepo: string,
  resources: RunResources,
  roles: Map<string, RoleDefinition> = resources.roles,
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
