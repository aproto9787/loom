import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  hookDefinitionSchema,
  skillDefinitionSchema,
  type AgentConfig,
  type FlowDefinition,
  type HookDefinition,
  type SkillDefinition,
} from "@loom/core";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const hooksDir = path.join(workspaceRoot, "hooks");
const skillsDir = path.join(workspaceRoot, "skills");

export interface AgentResourceScope {
  mcps: string[];
  hooks: string[];
  skills: string[];
}

export interface RunResources {
  hooks: Map<string, HookDefinition>;
  skills: Map<string, SkillDefinition>;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export async function loadHookDefinitions(): Promise<Map<string, HookDefinition>> {
  const map = new Map<string, HookDefinition>();
  try {
    await mkdir(hooksDir, { recursive: true });
    const entries = await readdir(hooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const raw = await readFile(path.join(hooksDir, entry.name), "utf8");
      const parsed = hookDefinitionSchema.safeParse(YAML.parse(raw));
      if (parsed.success) {
        map.set(parsed.data.name, parsed.data);
      }
    }
  } catch {
    console.warn("Failed to load hook definitions");
  }
  return map;
}

export async function loadSkillDefinitions(): Promise<Map<string, SkillDefinition>> {
  const map = new Map<string, SkillDefinition>();
  try {
    await mkdir(skillsDir, { recursive: true });
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const raw = await readFile(path.join(skillsDir, entry.name), "utf8");
      const parsed = skillDefinitionSchema.safeParse(YAML.parse(raw));
      if (parsed.success) {
        map.set(parsed.data.name, parsed.data);
      }
    }
  } catch {
    console.warn("Failed to load skill definitions");
  }
  return map;
}

export async function loadRunResources(): Promise<RunResources> {
  const [hooks, skills] = await Promise.all([loadHookDefinitions(), loadSkillDefinitions()]);
  return { hooks, skills };
}

export function resolveAgentResources(agent: AgentConfig, flow: FlowDefinition): AgentResourceScope {
  return {
    mcps: uniqueStrings([...(flow.resources?.mcps ?? []), ...(agent.mcps ?? [])]),
    hooks: uniqueStrings([...(flow.resources?.hooks ?? []), ...(agent.hooks ?? [])]),
    skills: uniqueStrings([...(flow.resources?.skills ?? []), ...(agent.skills ?? [])]),
  };
}

export async function createScopedMcpConfig(agent: AgentConfig, flow: FlowDefinition, homeDir?: string): Promise<string | undefined> {
  const scopedMcps = resolveAgentResources(agent, flow).mcps;
  if (scopedMcps.length === 0) {
    return undefined;
  }

  const sources = [
    ...(agent.isolated ? [] : [path.join(homeDir ?? os.homedir(), ".claude.json")]),
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
