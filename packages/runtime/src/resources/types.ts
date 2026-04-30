import type {
  HookDefinition,
  RoleDefinition,
  SkillDefinition,
} from "@aproto9787/loom-core";

export interface AgentResourceScope {
  mcps: string[];
  hooks: string[];
  skills: string[];
}

export interface RunResources {
  roles: Map<string, RoleDefinition>;
  hooks: Map<string, HookDefinition>;
  skills: Map<string, SkillDefinition>;
}

export interface ResourceLoadOptions {
  resourceRoot?: string;
}

export interface ScopedMcpOptions {
  workspaceRoot?: string;
}
