#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AgentType } from "@loom/core";
import { loadFlow, createScopedMcpConfig } from "../../../apps/server/src/runner.js";
import { buildConfiguredAgent } from "../../../apps/server/src/runner-prompt-builder.js";

const VERSION = "0.1.0";
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const examplesDir = path.join(workspaceRoot, "examples");

function handleFlags(): boolean {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`loom v${VERSION} — interactive flow launcher

Usage: loom [options]

Options:
  -h, --help     Show this help
  -v, --version  Show version

Scans for flow YAML files in the current directory and examples/,
presents an interactive selection menu, and spawns the chosen
flow's orchestrator (claude/codex) with isolated config.`);
    return true;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return true;
  }
  return false;
}

interface LoadedCliFlow {
  absolutePath: string;
  relativePath: string;
  flowDir: string;
  flow: Awaited<ReturnType<typeof loadFlow>>["flow"];
}

interface SelectionResult {
  flow: LoadedCliFlow;
}

interface RunRegistration {
  runId: string;
  cleanup: (exitCode: number) => Promise<void>;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectYamlFiles(rootDir: string, baseDir = rootDir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name.startsWith(".")) {
        return [];
      }
      return collectYamlFiles(absolutePath, baseDir);
    }
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      return [];
    }
    return [path.relative(baseDir, absolutePath)];
  }));
  return nested.flat().sort();
}

async function listFlowPaths(cwd: string): Promise<string[]> {
  const sources = [cwd, examplesDir].filter((value, index, array) => array.indexOf(value) === index);
  const discovered = await Promise.all(sources.map(async (source) => {
    if (!(await pathExists(source))) {
      return [];
    }
    const files = await collectYamlFiles(source, source);
    return files.map((file) => ({
      sortKey: source === cwd ? `0:${file}` : `1:${file}`,
      relativePath: source === cwd ? file : path.join("examples", file),
    }));
  }));

  const seen = new Set<string>();
  return discovered
    .flat()
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .filter((entry) => {
      const abs = path.resolve(cwd, entry.relativePath);
      if (seen.has(abs)) return false;
      seen.add(abs);
      return true;
    })
    .map((entry) => entry.relativePath);
}

async function loadCliFlow(flowPath: string, cwd: string): Promise<LoadedCliFlow> {
  const absolutePath = path.isAbsolute(flowPath)
    ? flowPath
    : flowPath.startsWith("examples/")
      ? path.join(workspaceRoot, flowPath)
      : path.resolve(cwd, flowPath);
  const loaded = await loadFlow(absolutePath);
  return {
    absolutePath: loaded.absolutePath,
    relativePath: flowPath,
    flowDir: loaded.flowDir,
    flow: loaded.flow,
  };
}

function resolveFlowCwd(flow: LoadedCliFlow): string {
  return path.isAbsolute(flow.flow.repo) ? flow.flow.repo : path.resolve(flow.flowDir, flow.flow.repo);
}

function buildSpawnArgs(agent: AgentConfig): { command: string; args: string[] } {
  if (agent.type === "claude-code") {
    const args = ["--dangerously-skip-permissions"];
    if (agent.model) {
      args.push("--model", agent.model);
    }
    return { command: "claude", args };
  }

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (agent.model) {
    args.push("-m", agent.model);
  }
  return { command: "codex", args };
}

function getServerOrigin(): string {
  return process.env.LOOM_SERVER_ORIGIN ?? "http://localhost:8787";
}

async function reportCliRunStart(flow: LoadedCliFlow, agentType: AgentType): Promise<RunRegistration> {
  const runId = randomUUID();
  const startTime = new Date().toISOString();
  const origin = getServerOrigin();

  try {
    await fetch(`${origin}/runs/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId,
        flowPath: flow.relativePath,
        flowName: flow.flow.name,
        agentType,
        startTime,
        source: "cli",
      }),
    });
  } catch {
    return { runId, cleanup: async () => undefined };
  }

  return {
    runId,
    cleanup: async (exitCode: number) => {
      try {
        await fetch(`${origin}/runs/${runId}/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            endTime: new Date().toISOString(),
            exitCode,
            status: exitCode === 0 ? "done" : "error",
          }),
        });
      } catch {
        // Server monitoring is best-effort for CLI launches.
      }
    },
  };
}

function summarizeTeamMembers(agent: AgentConfig): string {
  const children = agent.agents ?? [];
  if (children.length === 0) {
    return "";
  }

  const lines = [
    "# Team members available",
    "<!-- Use TeamCreate / Agent(name=<member>) to delegate. -->",
    ...children.map((child) => `- ${child.name} (${child.type}): ${child.system ?? ""}`.trimEnd()),
  ];

  return lines.join("\n");
}

function mergeClaudeMd(flowClaudeMd: string | undefined, agentClaudeMd: string | undefined, configuredAgent: AgentConfig): string {
  return [flowClaudeMd?.trim(), agentClaudeMd?.trim(), summarizeTeamMembers(configuredAgent)].filter(Boolean).join("\n\n");
}

function resolveAgentClaudeMd(flow: LoadedCliFlow, agent: AgentConfig): string | undefined {
  const ref = agent.claudeMdRef?.trim();
  if (!ref) {
    return undefined;
  }
  return flow.flow.claudeMdLibrary?.[ref];
}

async function createIsolatedHome(
  systemPrompt: string,
  flowClaudeMd: string | undefined,
  agentClaudeMd: string | undefined,
  configuredAgent: AgentConfig,
): Promise<string> {
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "loom-cli-home-"));
  const mergedClaudeMd = mergeClaudeMd(flowClaudeMd, agentClaudeMd, configuredAgent);
  await writeFile(
    path.join(isolatedHome, ".claude.json"),
    JSON.stringify({ env: {}, permissions: { allow: [] } }, null, 2),
    "utf8",
  );
  await writeFile(path.join(isolatedHome, ".claude.md"), mergedClaudeMd, "utf8");
  await writeFile(
    path.join(isolatedHome, ".codexrc"),
    JSON.stringify({ instructions: systemPrompt }, null, 2),
    "utf8",
  );
  return isolatedHome;
}

async function launchAgent(flow: LoadedCliFlow): Promise<number> {
  const agent: AgentConfig = { ...flow.flow.orchestrator } as AgentConfig & { isolated: true };
  const configuredAgent = buildConfiguredAgent(agent, flow.flow, flow.flow.repo, {
    roles: new Map(),
    hooks: new Map(),
    skills: new Map(),
  });
  const systemPrompt = configuredAgent.system ?? "";
  const agentClaudeMd = resolveAgentClaudeMd(flow, configuredAgent);
  const isolatedHome = await createIsolatedHome(systemPrompt, flow.flow.claudeMd, agentClaudeMd, configuredAgent);
  const scopedMcpConfigPath = await createScopedMcpConfig(agent, flow.flow, isolatedHome);
  const registration = await reportCliRunStart(flow, configuredAgent.type);
  const { command, args } = buildSpawnArgs(configuredAgent);
  const litellmEnv = configuredAgent.type === "claude-code" && configuredAgent.model?.startsWith("chatgpt/")
    ? {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
        ANTHROPIC_AUTH_TOKEN: "dummy-token",
      }
    : {};
  const child = spawn(command, args, {
    cwd: resolveFlowCwd(flow),
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
      CLAUDE_CONFIG_DIR: isolatedHome,
      CODEX_HOME: isolatedHome,
      CODEX_CONFIG_DIR: isolatedHome,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      CLAUDE_CODE_TEAMMATE_COMMAND: "/home/argoss/.claude/codex-bridge/codex-bridge.mjs",
      LOOM_FLOW_PATH: flow.absolutePath,
      LOOM_FLOW_NAME: flow.flow.name,
      ...litellmEnv,
      ...(scopedMcpConfigPath ? { LOOM_MCP_CONFIG_PATH: scopedMcpConfigPath } : {}),
    },
  });

  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", async (code, signal) => {
      if (scopedMcpConfigPath) {
        await rm(path.dirname(scopedMcpConfigPath), { recursive: true, force: true }).catch(() => undefined);
      }
      await rm(isolatedHome, { recursive: true, force: true }).catch(() => undefined);
      const resolvedCode = signal ? 1 : (code ?? 0);
      await registration.cleanup(resolvedCode);
      resolve(resolvedCode);
    });
  });
}

async function promptForSelection(flows: LoadedCliFlow[]): Promise<SelectionResult> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Available flows:\n");
    flows.forEach((flow, index) => {
      console.log(`  ${index + 1}. ${flow.flow.name} (${flow.relativePath})`);
    });
    const answer = await rl.question("\nSelect a flow number: ");
    const selection = Number.parseInt(answer, 10);
    if (!Number.isInteger(selection) || selection < 1 || selection > flows.length) {
      throw new Error("Invalid selection");
    }
    return { flow: flows[selection - 1]! };
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  if (handleFlags()) return;
  const cwd = process.cwd();
  const flowPaths = await listFlowPaths(cwd);
  const loadResults = await Promise.all(
    flowPaths.map(async (flowPath) => {
      try {
        return await loadCliFlow(flowPath, cwd);
      } catch {
        return null;
      }
    }),
  );
  const flows = loadResults.filter((f): f is LoadedCliFlow => f !== null);
  if (flows.length === 0) {
    throw new Error("No valid flow YAML files found in the current directory or examples/");
  }
  const selection = await promptForSelection(flows);
  const exitCode = await launchAgent(selection.flow);
  process.exitCode = exitCode;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
