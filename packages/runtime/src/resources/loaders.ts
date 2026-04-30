import path from "node:path";
import {
  hookDefinitionSchema,
  roleDefinitionSchema,
  skillDefinitionSchema,
  type HookDefinition,
  type RoleDefinition,
  type SkillDefinition,
} from "@aproto9787/loom-core";
import { getResourceRoot } from "./root.js";
import { loadYamlDirectory } from "./yaml-directory.js";
import type { ResourceLoadOptions, RunResources } from "./types.js";

export async function loadRoleDefinitions(
  options: ResourceLoadOptions = {},
): Promise<Map<string, RoleDefinition>> {
  return loadYamlDirectory(
    path.join(getResourceRoot(options), "roles"),
    (value) => roleDefinitionSchema.safeParse(value),
    (role) => role.name,
    "role",
  );
}

export async function loadHookDefinitions(
  options: ResourceLoadOptions = {},
): Promise<Map<string, HookDefinition>> {
  return loadYamlDirectory(
    path.join(getResourceRoot(options), "hooks"),
    (value) => hookDefinitionSchema.safeParse(value),
    (hook) => hook.name,
    "hook",
  );
}

export async function loadSkillDefinitions(
  options: ResourceLoadOptions = {},
): Promise<Map<string, SkillDefinition>> {
  return loadYamlDirectory(
    path.join(getResourceRoot(options), "skills"),
    (value) => skillDefinitionSchema.safeParse(value),
    (skill) => skill.name,
    "skill",
  );
}

export async function loadRunResources(
  options: ResourceLoadOptions = {},
): Promise<RunResources> {
  const [roles, hooks, skills] = await Promise.all([
    loadRoleDefinitions(options),
    loadHookDefinitions(options),
    loadSkillDefinitions(options),
  ]);

  return { roles, hooks, skills };
}
