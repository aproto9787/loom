import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { flowDefinitionSchema, type FlowDefinition } from "@loom/core";
import { validateFlow } from "@loom/nodes";
import { defaultWorkspaceRoot } from "./paths.js";

export interface LoadFlowOptions {
  workspaceRoot?: string;
}

export interface LoadedFlow {
  absolutePath: string;
  flowDir: string;
  flow: FlowDefinition;
}

export function resolveFlowPath(flowPath: string, options: LoadFlowOptions = {}): string {
  if (path.isAbsolute(flowPath)) {
    return flowPath;
  }
  return path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot(), flowPath);
}

export async function loadFlow(
  flowPath: string,
  options: LoadFlowOptions = {},
): Promise<LoadedFlow> {
  const absolutePath = resolveFlowPath(flowPath, options);
  const raw = await readFile(absolutePath, "utf8");
  const flow = flowDefinitionSchema.parse(YAML.parse(raw));
  const validationErrors = validateFlow(flow);

  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }

  return {
    absolutePath,
    flowDir: path.dirname(absolutePath),
    flow,
  };
}
