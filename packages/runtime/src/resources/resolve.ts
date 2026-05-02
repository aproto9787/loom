import type { AgentConfig, FlowDefinition } from "@aproto9787/heddle-core";
import { uniqueStrings } from "./root.js";
import type { AgentResourceScope } from "./types.js";

export function resolveAgentResources(
  agent: AgentConfig,
  flow: FlowDefinition,
): AgentResourceScope {
  return {
    mcps: uniqueStrings([...(flow.resources?.mcps ?? []), ...(agent.mcps ?? [])]),
    hooks: uniqueStrings([...(flow.resources?.hooks ?? []), ...(agent.hooks ?? [])]),
    skills: uniqueStrings([...(flow.resources?.skills ?? []), ...(agent.skills ?? [])]),
  };
}
