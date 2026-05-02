import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, FlowDefinition } from "@aproto9787/heddle-core";
import { defaultWorkspaceRoot } from "../paths.js";
import { resolveAgentResources } from "./resolve.js";
import type { ScopedMcpOptions } from "./types.js";

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

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "heddle-mcp-"));
  const configPath = path.join(tempDir, ".mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: selectedServers }, null, 2), "utf8");
  return configPath;
}
