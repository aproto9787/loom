import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  flowDefinitionSchema,
  migrateLegacyFlowDefinitionInput,
  type FlowDefinition,
  type LegacyMigrationNote,
} from "@aproto9787/heddle-core";
import { validateFlow } from "@aproto9787/heddle-core";
import { defaultWorkspaceRoot } from "./paths.js";

export interface LoadFlowOptions {
  workspaceRoot?: string;
}

export interface LoadedFlow {
  absolutePath: string;
  flowDir: string;
  flow: FlowDefinition;
  migrationNotes: LegacyMigrationNote[];
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
  const migrated = migrateLegacyFlowDefinitionInput(YAML.parse(raw));
  const flow = flowDefinitionSchema.parse(migrated.value);
  const validationErrors = validateFlow(flow);

  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }

  return {
    absolutePath,
    flowDir: path.dirname(absolutePath),
    flow,
    migrationNotes: migrated.notes,
  };
}
