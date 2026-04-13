export { abortRun, runFlow, streamRunFlow } from "./runner-executor.js";
export { buildAgentPrompt, buildConfiguredAgent } from "./runner-prompt-builder.js";
export { runHooks } from "./runner-hook-runner.js";
export {
  createScopedMcpConfig,
  loadHookDefinitions,
  loadRunResources,
  loadSkillDefinitions,
  resolveAgentResources,
  type AgentResourceScope,
  type RunResources,
} from "./runner-resource-loader.js";

import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { flowDefinitionSchema, type FlowDefinition } from "@loom/core";
import { validateFlow } from "@loom/nodes";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

export interface LoadedFlow {
  absolutePath: string;
  flowDir: string;
  flow: FlowDefinition;
}

function resolveFlowPath(flowPath: string): string {
  return path.isAbsolute(flowPath) ? flowPath : path.resolve(workspaceRoot, flowPath);
}

export async function loadFlow(flowPath: string): Promise<LoadedFlow> {
  const absolutePath = resolveFlowPath(flowPath);
  const raw = await readFile(absolutePath, "utf8");
  const flow = flowDefinitionSchema.parse(YAML.parse(raw));
  const validationErrors = validateFlow(flow);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }
  return { absolutePath, flowDir: path.dirname(absolutePath), flow };
}
