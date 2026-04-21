import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  hookDefinitionSchema,
  roleDefinitionSchema,
  skillDefinitionSchema,
  type AgentConfig,
  type FlowDefinition,
  type HookDefinition,
  type RoleDefinition,
  type SkillDefinition,
} from "@loom/core";
import { defaultWorkspaceRoot } from "./paths.js";

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

function getResourceRoot(options: ResourceLoadOptions = {}): string {
  return path.resolve(options.resourceRoot ?? defaultWorkspaceRoot());
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

async function loadYamlDirectory<T>(
  directory: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
  getName: (value: T) => string,
  label: string,
): Promise<Map<string, T>> {
  const map = new Map<string, T>();

  try {
    await mkdir(directory, { recursive: true });
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
        continue;
      }

      const raw = await readFile(path.join(directory, entry.name), "utf8");
      const parsed = parse(YAML.parse(raw));
      if (parsed.success) {
        map.set(getName(parsed.data), parsed.data);
      }
    }
  } catch {
    console.warn(`Failed to load ${label} definitions`);
  }

  return map;
}

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

export async function createScopedMcpConfig(
  agent: AgentConfig,
  flow: FlowDefinition,
  homeDir?: string,
  options: ScopedMcpOptions = {},
): Promise<string | undefined> {
  const scopedMcps = resolveAgentResources(agent, flow).mcps;
  if (scopedMcps.length === 0) {
    return undefined;
  }

  const workspaceRoot = path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot());
  const sources = [
    path.join(homeDir ?? os.homedir(), ".claude.json"),
    path.join(workspaceRoot, ".mcp.json"),
  ];

  const mergedServers: Record<string, unknown> = {};
  for (const source of sources) {
    try {
      const raw = await readFile(source, "utf8");
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      Object.assign(mergedServers, parsed.mcpServers ?? {});
    } catch {
      console.warn(`Failed to read MCP config: ${source}`);
    }
  }

  const selectedServers = Object.fromEntries(
    scopedMcps
      .map((name) => [name, mergedServers[name]] as const)
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  );

  if (Object.keys(selectedServers).length === 0) {
    return undefined;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-mcp-"));
  const configPath = path.join(tempDir, ".mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: selectedServers }, null, 2), "utf8");
  return configPath;
}
