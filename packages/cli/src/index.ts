#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import * as HeddleCore from "@aproto9787/heddle-core";
import type { AgentConfig, AgentType, FlowDefinition, TimelineEvent } from "@aproto9787/heddle-core";
import { runHeddleMcpServer } from "@aproto9787/heddle-mcp";
import { buildConfiguredAgent } from "@aproto9787/heddle-runtime";
import { createCodexInstructionHome, type CodexInstructionHome } from "./codex-home.js";
import { buildDelegationPrompt } from "./delegation-prompt.js";
import { buildHeadlessPrompt } from "./session-prompts.js";

const VERSION = "0.1.2";
const cliDistDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(cliDistDir, "..");
const workspaceRoot = path.resolve(cliDistDir, "../../..");
const sourceExamplesDir = path.join(workspaceRoot, "examples");
const packageExamplesDir = path.join(packageRoot, "examples");

function handleFlags(): boolean {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`heddle v${VERSION} — interactive flow launcher

Usage:
  heddle
  heddle mcp
  heddle --flow <path-to-flow.yaml>
  heddle <path-to-flow.yaml>
  heddle --flow <path-to-flow.yaml> --prompt "Task" --headless

Options:
  -f, --flow <path>       Launch a specific flow without the selection prompt
  -p, --prompt <text>     Root task prompt for headless/non-interactive runs
      --prompt-file <p>   Read the root task prompt from a file
      --run-id <id>       Reuse a server-created run id
      --server <origin>   Event/status server origin (default: http://localhost:8787)
      --headless          Run without taking over the terminal; used by the local server
  -h, --help              Show this help
  -v, --version           Show version

Without --headless, Heddle scans for flow YAML files in the current
directory and examples/, presents an interactive selection menu, and
spawns the chosen flow's orchestrator with the host terminal.

\`heddle mcp\` starts the stdio MCP delegation bridge for a Heddle host
leader. It expects HEDDLE_FLOW_PATH, HEDDLE_AGENT, and HEDDLE_SUBAGENT_BIN
in the environment.`);
    return true;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return true;
  }
  return false;
}

interface CliOptions {
  flowPath?: string;
  prompt?: string;
  promptFile?: string;
  runId?: string;
  serverOrigin?: string;
  headless: boolean;
}

function parseCliOptions(argv = process.argv.slice(2)): CliOptions {
  const positional: string[] = [];
  const options: CliOptions = { headless: false };

  const readValue = (index: number, name: string, allowDashValue = false): [string | undefined, number] => {
    const next = argv[index + 1];
    if (next === undefined || (!allowDashValue && next.startsWith("-"))) {
      throw new Error(`heddle: ${name} requires a value`);
    }
    return [next, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i];
    if (cur === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (cur === "--headless") {
      options.headless = true;
      continue;
    }
    if (cur === "--flow" || cur === "-f") {
      const [value, nextIndex] = readValue(i, cur);
      options.flowPath = value;
      i = nextIndex;
      continue;
    }
    if (cur.startsWith("--flow=")) {
      options.flowPath = cur.slice("--flow=".length).trim() || undefined;
      continue;
    }
    if (cur === "--prompt" || cur === "-p") {
      const [value, nextIndex] = readValue(i, cur, true);
      options.prompt = value;
      i = nextIndex;
      continue;
    }
    if (cur.startsWith("--prompt=")) {
      options.prompt = cur.slice("--prompt=".length);
      continue;
    }
    if (cur === "--prompt-file") {
      const [value, nextIndex] = readValue(i, cur);
      options.promptFile = value;
      i = nextIndex;
      continue;
    }
    if (cur.startsWith("--prompt-file=")) {
      options.promptFile = cur.slice("--prompt-file=".length).trim() || undefined;
      continue;
    }
    if (cur === "--run-id") {
      const [value, nextIndex] = readValue(i, cur);
      options.runId = value;
      i = nextIndex;
      continue;
    }
    if (cur.startsWith("--run-id=")) {
      options.runId = cur.slice("--run-id=".length).trim() || undefined;
      continue;
    }
    if (cur === "--server") {
      const [value, nextIndex] = readValue(i, cur);
      options.serverOrigin = value;
      i = nextIndex;
      continue;
    }
    if (cur.startsWith("--server=")) {
      options.serverOrigin = cur.slice("--server=".length).trim() || undefined;
      continue;
    }
    if (cur.startsWith("-")) {
      throw new Error(`heddle: unknown option ${cur}`);
    }
    positional.push(cur);
  }

  options.flowPath ??= positional.shift();
  if (!options.prompt && positional.length > 0) {
    options.prompt = positional.join(" ").trim();
  }
  return options;
}

async function readHeadlessPrompt(options: CliOptions): Promise<string | undefined> {
  if (options.promptFile) {
    return (await readFile(path.resolve(options.promptFile), "utf8")).trim();
  }
  if (options.prompt?.trim()) {
    return options.prompt.trim();
  }
  if (options.headless && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const piped = Buffer.concat(chunks).toString("utf8").trim();
    return piped || undefined;
  }
  return undefined;
}

interface LoadedCliFlow {
  absolutePath: string;
  relativePath: string;
  flowDir: string;
  flow: FlowDefinition;
  migrationNotes: string[];
}

interface SelectionResult {
  flow: LoadedCliFlow;
}

interface RunRegistration {
  runId: string;
  cleanup: (exitCode: number) => Promise<void>;
  postEvents: (events: HeddleRunEvent[]) => Promise<void>;
}

interface LeaderMcpConfig {
  codexConfigToml: string;
  cleanup: () => Promise<void>;
}

type HeddleRunEvent = TimelineEvent;

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
  const sources = [cwd, sourceExamplesDir, packageExamplesDir].filter((value, index, array) => array.indexOf(value) === index);
  const discovered = await Promise.all(sources.map(async (source) => {
    if (!(await pathExists(source))) {
      return [];
    }
    const files = await collectYamlFiles(source, source);
    return files.map((file) => ({
      sortKey: source === cwd ? `0:${file}` : `1:${file}`,
      relativePath: source === cwd ? file : path.join("examples", file),
      absolutePath: path.resolve(source, file),
    }));
  }));

  const seen = new Set<string>();
  return discovered
    .flat()
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .filter((entry) => {
      if (seen.has(entry.absolutePath)) return false;
      seen.add(entry.absolutePath);
      return true;
    })
    .map((entry) => entry.relativePath);
}

async function loadCliFlow(flowPath: string, cwd: string): Promise<LoadedCliFlow> {
  let absolutePath = path.isAbsolute(flowPath) ? flowPath : path.resolve(cwd, flowPath);
  if (!path.isAbsolute(flowPath) && flowPath.startsWith("examples/")) {
    const candidates = [
      path.resolve(cwd, flowPath),
      path.join(sourceExamplesDir, flowPath.slice("examples/".length)),
      path.join(packageExamplesDir, flowPath.slice("examples/".length)),
    ];
    absolutePath = candidates.find((candidate) => existsSync(candidate)) ?? absolutePath;
  }
  const raw = await readFile(absolutePath, "utf8");
  const migration = migrateLegacyFlowToCodex(YAML.parse(raw));
  const flow = HeddleCore.flowSchema.parse(migration.value);
  const validationErrors = HeddleCore.validateFlow(flow);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }
  logMigrationNotes(`flow ${flowPath}`, migration.notes);
  return {
    absolutePath,
    relativePath: flowPath,
    flowDir: path.dirname(absolutePath),
    flow,
    migrationNotes: migration.notes,
  };
}

function resolveFlowCwd(flow: LoadedCliFlow): string {
  const repo = flow.flow.repo;
  if (!repo) return process.cwd();
  return path.isAbsolute(repo) ? repo : path.resolve(process.cwd(), repo);
}

interface MigrationResult<T> {
  value: T;
  notes: string[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasLegacyAgentType(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as { type?: unknown }).type === "claude-code") return true;
  if ((value as { agentType?: unknown }).agentType === "claude-code") return true;
  if (Array.isArray(value)) return value.some((entry) => hasLegacyAgentType(entry));
  return Object.values(value as Record<string, unknown>).some((entry) => hasLegacyAgentType(entry));
}

function migrationNotesFrom(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const notes = record.notes ?? record.migrationNotes ?? record.warnings;
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object") return "";
        const note = entry as { path?: unknown; from?: unknown; to?: unknown; message?: unknown };
        const pathLabel = typeof note.path === "string" ? note.path : "legacy";
        const from = typeof note.from === "string" ? note.from : undefined;
        const to = typeof note.to === "string" ? note.to : undefined;
        const message = typeof note.message === "string" ? note.message : undefined;
        return [pathLabel, from && to ? `${from} -> ${to}` : undefined, message].filter(Boolean).join(": ");
      })
      .filter((entry) => entry.trim().length > 0);
  }
  return [];
}

function migrationValueFrom<T>(value: unknown): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return (record.flow ?? record.value ?? record.migrated ?? record.result ?? value) as T;
}

function runCoreLegacyMigration<T>(value: T): MigrationResult<T> | undefined {
  const helpers = [
    "migrateLegacyFlowDefinitionInput",
    "migrateLegacyFlowToCodex",
    "migrateLegacyAgentTypesToCodex",
    "migrateLegacyClaudeCodeToCodex",
    "normalizeLegacyAgentTypes",
  ];
  const coreExports = HeddleCore as Record<string, unknown>;

  for (const helperName of helpers) {
    const helper = coreExports[helperName];
    if (typeof helper !== "function") continue;
    try {
      const migrated = helper(cloneJson(value)) as unknown;
      const migrationValue = migrationValueFrom<T>(migrated);
      if (!migrationValue) continue;
      const notes = migrationNotesFrom(migrated);
      return {
        value: migrationValue,
        notes: notes.length > 0 ? notes : [`core legacy migration helper ${helperName} applied`],
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function migrateRuntimeDefaults(agent: Record<string, unknown>, pathLabel: string, notes: string[]): void {
  const runtime = agent.runtime && typeof agent.runtime === "object"
    ? { ...(agent.runtime as Record<string, unknown>) }
    : {};
  if (runtime.profile === undefined || runtime.profile === "claude-default") {
    runtime.profile = "codex-default";
    notes.push(`${pathLabel}.runtime.profile -> codex-default`);
  }
  if (runtime.mode === undefined) runtime.mode = "host";
  if (runtime.applyResources === undefined) runtime.applyResources = "prompt-only";
  if (runtime.delegationTransport === undefined) runtime.delegationTransport = "mcp";
  agent.runtime = runtime;

  if (agent.model === undefined || (typeof agent.model === "string" && agent.model.startsWith("claude-"))) {
    agent.model = "gpt-5.5";
    notes.push(`${pathLabel}.model -> gpt-5.5`);
  }
}

function migrateAgentRecord(value: unknown, pathLabel: string, notes: string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const agent = { ...(value as Record<string, unknown>) };
  if (agent.type === "claude-code") {
    agent.type = "codex";
    notes.push(`${pathLabel}.type claude-code -> codex`);
  }
  if (agent.type === "codex") {
    migrateRuntimeDefaults(agent, pathLabel, notes);
  }
  if (Array.isArray(agent.agents)) {
    agent.agents = agent.agents.map((child, index) => migrateAgentRecord(child, `${pathLabel}.agents.${index}`, notes));
  }
  return agent;
}

function applyBuiltInFlowMigration<T>(value: T): MigrationResult<T> {
  const notes: string[] = [];
  if (!value || typeof value !== "object") return { value, notes };
  const flow = { ...(value as Record<string, unknown>) };
  if (flow.orchestrator) {
    flow.orchestrator = migrateAgentRecord(flow.orchestrator, "orchestrator", notes);
  }
  return { value: flow as T, notes };
}

function migrateLegacyFlowToCodex<T>(value: T): MigrationResult<T> {
  if (!hasLegacyAgentType(value)) {
    return { value, notes: [] };
  }

  const coreMigration = runCoreLegacyMigration(value);
  const builtInMigration = applyBuiltInFlowMigration(coreMigration?.value ?? value);
  return {
    value: builtInMigration.value,
    notes: [
      ...(coreMigration?.notes ?? ["core legacy migration helper unavailable; applied built-in Codex migration"]),
      ...builtInMigration.notes,
    ],
  };
}

function migrateLegacyAgentToCodex(agent: AgentConfig, pathLabel: string): MigrationResult<AgentConfig> {
  const flowMigration = migrateLegacyFlowToCodex({ orchestrator: agent });
  const migrated = flowMigration.value as { orchestrator: AgentConfig };
  return { value: migrated.orchestrator, notes: flowMigration.notes.map((note) => note.replace(/^orchestrator/, pathLabel)) };
}

function logMigrationNotes(scope: string, notes: string[]): void {
  for (const note of notes) {
    console.warn(`[heddle] migrated legacy Claude configuration in ${scope}: ${note}`);
  }
}

function buildSpawnArgs(agent: AgentConfig): { command: string; args: string[] } {
  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  args.push("-m", agent.model ?? "gpt-5.5");
  return { command: "codex", args };
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexMcpConfigToml(env: Record<string, string>, command: string, args: string[]): string {
  const envEntries = Object.entries(env)
    .map(([key, value]) => `${key} = ${quoteTomlString(value)}`)
    .join(", ");
  const argsArray = args.map(quoteTomlString).join(", ");
  return [
    "[mcp_servers.heddle]",
    `command = ${quoteTomlString(command)}`,
    `args = [${argsArray}]`,
    `env = { ${envEntries} }`,
  ].join("\n");
}

async function createLeaderMcpConfig(
  flow: LoadedCliFlow,
  configuredAgent: AgentConfig,
  flowCwd: string,
  registration: RunRegistration,
  serverOrigin: string,
): Promise<LeaderMcpConfig> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "heddle-leader-mcp-"));
  const cliBin = fileURLToPath(new URL("./index.js", import.meta.url));
  const subagentBin = fileURLToPath(new URL("./subagent-launcher.js", import.meta.url));
  const env: Record<string, string> = {
    HEDDLE_FLOW_PATH: flow.absolutePath,
    HEDDLE_FLOW_NAME: flow.flow.name,
    HEDDLE_FLOW_CWD: flowCwd,
    HEDDLE_AGENT: configuredAgent.name,
    HEDDLE_AGENT_TYPE: configuredAgent.type,
    HEDDLE_RUN_ID: registration.runId,
    HEDDLE_SERVER_ORIGIN: serverOrigin,
    HEDDLE_PARENT_AGENT: configuredAgent.name,
    HEDDLE_PARENT_DEPTH: "0",
    HEDDLE_SUBAGENT_BIN: subagentBin,
  };
  return {
    codexConfigToml: buildCodexMcpConfigToml(env, process.execPath, [cliBin, "mcp"]),
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function getServerOrigin(explicitOrigin?: string): string {
  return explicitOrigin ?? process.env.HEDDLE_SERVER_ORIGIN ?? "http://localhost:8787";
}

function summarizeText(value: string | undefined, maxLength = 120): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function parseEventTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function extractMessageText(message: unknown): string | undefined {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return summarizeText(message.map((entry) => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object") return "";
      const typedEntry = entry as Record<string, unknown>;
      return typeof typedEntry.text === "string" ? typedEntry.text : "";
    }).filter(Boolean).join(" "));
  }
  return undefined;
}

function mapCodexHeadlessLine(runId: string, line: string, leaderName = "leader"): HeddleRunEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.type !== "item.completed") return null;
  const item = parsed.item;
  if (!item || typeof item !== "object") return null;
  const typedItem = item as Record<string, unknown>;
  const itemType = typeof typedItem.type === "string" ? typedItem.type : undefined;
  const ts = parseEventTimestamp(parsed.timestamp ?? parsed.ts);
  if (itemType === "agent_message") {
    const text = typeof typedItem.text === "string" ? typedItem.text : undefined;
    const summary = summarizeText(text);
    if (!summary) return null;
    return { runId, ts, type: "assistant", summary, agentName: leaderName, agentDepth: 0, agentKind: "codex", raw: parsed };
  }
  if (itemType === "reasoning") {
    const text = typeof typedItem.text === "string" ? typedItem.text : "reasoning";
    return { runId, ts, type: "assistant", summary: summarizeText(`reasoning: ${text}`), toolName: "reasoning", agentName: leaderName, agentDepth: 0, agentKind: "codex", raw: parsed };
  }
  if (itemType === "command_execution") {
    const command = typeof typedItem.command === "string" ? typedItem.command : "command";
    return { runId, ts, type: "tool_use", summary: summarizeText(command), toolName: "Bash", agentName: leaderName, agentDepth: 0, agentKind: "codex", raw: parsed };
  }
  if (itemType === "file_change") {
    const pathStr = typeof typedItem.path === "string" ? typedItem.path : "";
    const op = typeof typedItem.operation === "string" ? typedItem.operation : "edit";
    return { runId, ts, type: "tool_result", summary: summarizeText(`${op} ${pathStr}`), toolName: "Edit", agentName: leaderName, agentDepth: 0, agentKind: "codex", raw: parsed };
  }
  return { runId, ts, type: "tool_use", summary: summarizeText(itemType ?? "codex item"), toolName: itemType, agentName: leaderName, agentDepth: 0, agentKind: "codex", raw: parsed };
}

function mapHeadlessStdoutLine(runId: string, line: string, agentType: AgentType, leaderName = "leader"): HeddleRunEvent[] {
  const mapped = mapCodexHeadlessLine(runId, line, leaderName);
  return mapped ? [mapped] : [];
}

async function postRunEvents(origin: string, runId: string, events: HeddleRunEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await fetch(`${origin}/runs/${runId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch {
    // Event streaming is best-effort for CLI launches.
  }
}

async function reportCliRunStart(
  flow: LoadedCliFlow,
  agentType: AgentType,
  options: CliOptions,
  userPrompt = "",
): Promise<RunRegistration> {
  const runId = options.runId ?? randomUUID();
  const startTime = new Date().toISOString();
  const origin = getServerOrigin(options.serverOrigin);

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
        cwd: resolveFlowCwd(flow),
        userPrompt,
      }),
    });
  } catch {
    return { runId, cleanup: async () => undefined, postEvents: async () => undefined };
  }

  return {
    runId,
    postEvents: async (events: HeddleRunEvent[]) => {
      await postRunEvents(origin, runId, events);
    },
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
    "<!-- Delegate only through Heddle MCP delegation tools. Do not use TeamCreate, Agent(name=...), or direct heddle-subagent Bash commands. -->",
    ...children.map((child) => `- ${child.name} (${child.type}): ${child.system ?? ""}`.trimEnd()),
  ];

  return lines.join("\n");
}

function mergeFlowMd(flowFlowMd: string | undefined, agentFlowMd: string | undefined, configuredAgent: AgentConfig): string {
  return [flowFlowMd?.trim(), agentFlowMd?.trim(), summarizeTeamMembers(configuredAgent)].filter(Boolean).join("\n\n");
}

function resolveAgentFlowMd(flow: LoadedCliFlow, agent: AgentConfig): string | undefined {
  const ref = agent.flowMdRef?.trim();
  if (!ref) {
    return undefined;
  }
  return flow.flow.flowMdLibrary?.[ref];
}


function buildHeadlessSpawnArgs(agent: AgentConfig, finalInstructions: string, userPrompt: string, mcpConfigPath?: string): { command: string; args: string[] } {
  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--model", agent.model ?? "gpt-5.5",
  ];
  args.push(buildHeadlessPrompt(finalInstructions, userPrompt));
  return { command: "codex", args };
}

async function runHeadlessAgent(
  flow: LoadedCliFlow,
  configuredAgent: AgentConfig,
  finalInstructions: string,
  userPrompt: string,
  flowCwd: string,
  registration: RunRegistration,
  serverOrigin: string,
  extraEnv: Record<string, string>,
  mcpConfigPath?: string,
): Promise<number> {
  const { command, args } = buildHeadlessSpawnArgs(configuredAgent, finalInstructions, userPrompt, mcpConfigPath);
  const childEnv = {
    ...process.env,
    ...extraEnv,
    HEDDLE_FLOW_PATH: flow.absolutePath,
    HEDDLE_FLOW_NAME: flow.flow.name,
    HEDDLE_FLOW_CWD: flowCwd,
    HEDDLE_AGENT: configuredAgent.name,
    HEDDLE_AGENT_TYPE: configuredAgent.type,
    HEDDLE_RUN_ID: registration.runId,
    HEDDLE_SERVER_ORIGIN: serverOrigin,
    HEDDLE_PARENT_AGENT: configuredAgent.name,
    HEDDLE_PARENT_DEPTH: "0",
    HEDDLE_SUBAGENT_BIN: fileURLToPath(new URL("./subagent-launcher.js", import.meta.url)),
  };

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: flowCwd,
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv,
    });

    let buffer = "";
    const flushLine = (line: string) => {
      const events = mapHeadlessStdoutLine(registration.runId, line, configuredAgent.type, configuredAgent.name);
      if (events.length > 0) {
        void registration.postEvents(events);
      }
    };
    const flush = (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) flushLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      process.stdout.write(chunk);
      flush(chunk);
    });
    child.once("error", async (error) => {
      await registration.cleanup(1).catch(() => undefined);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      if (buffer.trim()) flushLine(buffer.trim());
      const resolvedCode = signal ? 1 : (code ?? 0);
      await registration.cleanup(resolvedCode);
      resolve(resolvedCode);
    });
  });
}

async function launchAgent(flow: LoadedCliFlow, options: CliOptions): Promise<number> {
  // The root agent runs with an ephemeral CODEX_HOME whose AGENTS.md combines
  // the real global AGENTS.md with this flow's instructions.
  const agent: AgentConfig = { ...flow.flow.orchestrator };
  const rawConfiguredAgent = buildConfiguredAgent(agent, flow.flow, flow.flow.repo, {
    roles: new Map(),
    hooks: new Map(),
    skills: new Map(),
  });
  const configuredAgentMigration = migrateLegacyAgentToCodex(rawConfiguredAgent, "orchestrator");
  logMigrationNotes("configured agent", configuredAgentMigration.notes);
  const configuredAgent = configuredAgentMigration.value;
  const agentFlowMd = resolveAgentFlowMd(flow, configuredAgent);
  const mergedInstructions = mergeFlowMd(flow.flow.flowMd, agentFlowMd, configuredAgent);
  const flowCwd = resolveFlowCwd(flow);
  const userPrompt = await readHeadlessPrompt(options);
  if (options.headless && !userPrompt) {
    throw new Error("heddle: --headless requires --prompt, --prompt-file, or piped stdin");
  }
  const registration = await reportCliRunStart(flow, configuredAgent.type, options, userPrompt ?? "");
  const leaderMcpConfig = await createLeaderMcpConfig(flow, configuredAgent, flowCwd, registration, getServerOrigin(options.serverOrigin));
  const delegationPrompt = buildDelegationPrompt(configuredAgent, configuredAgent.name);
  const finalInstructions = delegationPrompt
    ? (mergedInstructions.trim()
        ? `${mergedInstructions}\n\n${delegationPrompt}`
        : delegationPrompt)
    : mergedInstructions;
  if (options.headless) {
    let headlessCodexHome: CodexInstructionHome | undefined;
    const extraEnv: Record<string, string> = {};
    headlessCodexHome = await createCodexInstructionHome({
      instructions: "",
      configAppend: leaderMcpConfig.codexConfigToml,
      writeAgents: false,
    });
    extraEnv.CODEX_HOME = headlessCodexHome.codexHome;
    extraEnv.CODEX_CONFIG_DIR = headlessCodexHome.codexHome;
    try {
      return await runHeadlessAgent(
        flow,
        configuredAgent,
        finalInstructions,
        userPrompt ?? "",
        flowCwd,
        registration,
        getServerOrigin(options.serverOrigin),
        extraEnv,
      );
    } finally {
      await headlessCodexHome?.cleanup().catch(() => undefined);
      await leaderMcpConfig.cleanup().catch(() => undefined);
    }
  }

  const { command, args } = buildSpawnArgs(configuredAgent);
  let codexInstructionHome: CodexInstructionHome | undefined;
  codexInstructionHome = await createCodexInstructionHome({
    instructions: finalInstructions,
    configAppend: leaderMcpConfig.codexConfigToml,
  });

  const finalizeRun = async (exitCode: number) => {
    await codexInstructionHome?.cleanup().catch(() => undefined);
    await leaderMcpConfig.cleanup().catch(() => undefined);
    await registration.cleanup(exitCode);
  };

  // Hand the TTY back to the child cleanly: readline may have left stdin
  // in raw mode with bracketed-paste/mouse tracking off, which breaks
  // ctrl+v, arrow keys, etc. when the child takes over with stdio:inherit.
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
  process.stdin.pause();
  if (process.stdout.isTTY && typeof process.stdout.write === "function") {
    process.stdout.write("\x1b[?2004h"); // re-enable bracketed paste
  }

  const child = spawn(command, args, {
    cwd: flowCwd,
    stdio: "inherit",
    env: {
      ...process.env,
      HEDDLE_FLOW_PATH: flow.absolutePath,
      HEDDLE_FLOW_NAME: flow.flow.name,
      HEDDLE_FLOW_CWD: flowCwd,
      HEDDLE_AGENT: configuredAgent.name,
      HEDDLE_AGENT_TYPE: configuredAgent.type,
      HEDDLE_RUN_ID: registration.runId,
      HEDDLE_SERVER_ORIGIN: getServerOrigin(options.serverOrigin),
      HEDDLE_PARENT_AGENT: configuredAgent.name,
      HEDDLE_PARENT_DEPTH: "0",
      HEDDLE_SUBAGENT_BIN: fileURLToPath(new URL("./subagent-launcher.js", import.meta.url)),
      ...(codexInstructionHome
        ? {
            CODEX_HOME: codexInstructionHome.codexHome,
            CODEX_CONFIG_DIR: codexInstructionHome.codexHome,
          }
        : {}),
    },
  });

  return await new Promise<number>((resolve, reject) => {
    child.once("error", async (error) => {
      await finalizeRun(1).catch(() => undefined);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      const resolvedCode = signal ? 1 : (code ?? 0);
      await finalizeRun(resolvedCode);
      resolve(resolvedCode);
    });
  });
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildFlowTemplate(name: string): string {
  return `name: ${name}
description: |
  TODO: describe this flow.
repo: .
flowMd: |
  # Flow Common Policy
  - 범위 엄수. 인접 불가침. 가정 명시.
flowMdLibrary: {}
orchestrator:
  name: leader
  type: codex
  runtime:
    mode: host
    profile: codex-default
    applyResources: prompt-only
    delegationTransport: mcp
  model: gpt-5.5
  system: |
    You are the orchestrator for ${name}. Delegate work to your team.
  effort: xhigh
  delegation: []
  agents: []
`;
}

async function createNewFlowInteractive(rl: readline.Interface, cwd: string): Promise<string> {
  const rawName = (await rl.question("New flow name: ")).trim();
  if (!rawName) throw new Error("Flow name is required");
  const slug = slugify(rawName) || `flow-${Date.now()}`;
  const targetDir = cwd;
  await mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, `${slug}.yaml`);
  if (await pathExists(targetPath)) {
    throw new Error(`${targetPath} already exists`);
  }
  await writeFile(targetPath, buildFlowTemplate(rawName), "utf8");
  return targetPath;
}

type SelectionAction =
  | { kind: "flow"; flow: LoadedCliFlow }
  | { kind: "created"; absolutePath: string };

async function promptForSelection(flows: LoadedCliFlow[]): Promise<SelectionAction> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Available flows:\n");
    flows.forEach((flow, index) => {
      console.log(`  ${index + 1}. ${flow.flow.name} (${flow.relativePath})`);
    });
    console.log("  n. Create new flow");
    const answer = (await rl.question("\nSelect a flow number (or 'n'): ")).trim();
    if (answer.toLowerCase() === "n") {
      const created = await createNewFlowInteractive(rl, process.cwd());
      return { kind: "created", absolutePath: created };
    }
    const selection = Number.parseInt(answer, 10);
    if (!Number.isInteger(selection) || selection < 1 || selection > flows.length) {
      throw new Error("Invalid selection");
    }
    return { kind: "flow", flow: flows[selection - 1]! };
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "mcp") {
    await runHeddleMcpServer({
      env: {
        ...process.env,
        HEDDLE_SUBAGENT_BIN: process.env.HEDDLE_SUBAGENT_BIN ?? fileURLToPath(new URL("./subagent-launcher.js", import.meta.url)),
      },
    });
    return;
  }
  if (handleFlags()) return;
  const cwd = process.cwd();
  const options = parseCliOptions();
  if (options.flowPath) {
    const flow = await loadCliFlow(options.flowPath, cwd);
    const exitCode = await launchAgent(flow, options);
    process.exitCode = exitCode;
    return;
  }
  if (options.headless) {
    throw new Error("heddle: --headless requires --flow <path>");
  }

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
    console.log("No flow YAML files found. Launching flow-creation prompt.\n");
  }
  if (!process.stdin.isTTY) {
    throw new Error("heddle: interactive flow selection requires a TTY. Pass --flow <path> or a positional flow path to skip the prompt.");
  }

  const selection = await promptForSelection(flows);
  if (selection.kind === "created") {
    console.log(`\nCreated ${selection.absolutePath}`);
    console.log("Edit the flow YAML then run 'heddle' again to launch it.");
    return;
  }
  const exitCode = await launchAgent(selection.flow, options);
  process.exitCode = exitCode;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
