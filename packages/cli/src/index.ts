#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AgentType, TimelineEvent } from "@loom/core";
import { runLoomMcpServer } from "@loom/mcp";
import { loadFlow } from "@loom/runtime";
import { buildConfiguredAgent } from "@loom/runtime";
import { createCodexInstructionHome, type CodexInstructionHome } from "./codex-home.js";
import { buildDelegationPrompt } from "./delegation-prompt.js";
import { buildHeadlessPrompt } from "./session-prompts.js";

const VERSION = "0.1.0";
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const examplesDir = path.join(workspaceRoot, "examples");

function handleFlags(): boolean {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`loom v${VERSION} — interactive flow launcher

Usage:
  loom
  loom mcp
  loom --flow <path-to-flow.yaml>
  loom <path-to-flow.yaml>
  loom --flow <path-to-flow.yaml> --prompt "Task" --headless

Options:
  -f, --flow <path>       Launch a specific flow without the selection prompt
  -p, --prompt <text>     Root task prompt for headless/non-interactive runs
      --prompt-file <p>   Read the root task prompt from a file
      --run-id <id>       Reuse a server-created run id
      --server <origin>   Event/status server origin (default: http://localhost:8787)
      --headless          Run without taking over the terminal; used by the local server
  -h, --help              Show this help
  -v, --version           Show version

Without --headless, Loom scans for flow YAML files in the current
directory and examples/, presents an interactive selection menu, and
spawns the chosen flow's orchestrator with the host terminal.

\`loom mcp\` starts the stdio MCP delegation bridge for a Loom host
leader. It expects LOOM_FLOW_PATH, LOOM_AGENT, and LOOM_SUBAGENT_BIN
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
      throw new Error(`loom: ${name} requires a value`);
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
      throw new Error(`loom: unknown option ${cur}`);
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
  flow: Awaited<ReturnType<typeof loadFlow>>["flow"];
}

interface SelectionResult {
  flow: LoadedCliFlow;
}

interface RunRegistration {
  runId: string;
  cleanup: (exitCode: number) => Promise<void>;
  postEvents: (events: LoomRunEvent[]) => Promise<void>;
}

interface LeaderMcpConfig {
  claudeConfigPath: string;
  codexConfigToml: string;
  cleanup: () => Promise<void>;
}

type LoomRunEvent = TimelineEvent;

interface TranscriptTailState {
  readonly transcriptDir: string;
  readonly discoveredFiles: ReadonlySet<string>;
  readonly eventCount: number;
  close: () => Promise<void>;
  flushBundle: () => Promise<void>;
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
  const repo = flow.flow.repo;
  if (!repo) return process.cwd();
  return path.isAbsolute(repo) ? repo : path.resolve(process.cwd(), repo);
}

function buildSpawnArgs(agent: AgentConfig): { command: string; args: string[] } {
  if (agent.type === "claude-code") {
    const args = ["--dangerously-skip-permissions"];
    if (agent.model) {
      args.push("--model", agent.model);
    }
    return { command: "claude", args };
  }

  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  if (agent.model) {
    args.push("-m", agent.model);
  }
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
    "[mcp_servers.loom]",
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-leader-mcp-"));
  const cliBin = fileURLToPath(new URL("./index.js", import.meta.url));
  const subagentBin = fileURLToPath(new URL("./subagent-launcher.js", import.meta.url));
  const env: Record<string, string> = {
    LOOM_FLOW_PATH: flow.absolutePath,
    LOOM_FLOW_NAME: flow.flow.name,
    LOOM_FLOW_CWD: flowCwd,
    LOOM_AGENT: configuredAgent.name,
    LOOM_AGENT_TYPE: configuredAgent.type,
    LOOM_RUN_ID: registration.runId,
    LOOM_SERVER_ORIGIN: serverOrigin,
    LOOM_PARENT_AGENT: configuredAgent.name,
    LOOM_PARENT_DEPTH: "0",
    LOOM_SUBAGENT_BIN: subagentBin,
  };
  const claudeConfigPath = path.join(tempDir, "mcp.json");
  await writeFile(
    claudeConfigPath,
    JSON.stringify({
      mcpServers: {
        loom: {
          command: process.execPath,
          args: [cliBin, "mcp"],
          env,
        },
      },
    }, null, 2),
    "utf8",
  );
  return {
    claudeConfigPath,
    codexConfigToml: buildCodexMcpConfigToml(env, process.execPath, [cliBin, "mcp"]),
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function getServerOrigin(explicitOrigin?: string): string {
  return explicitOrigin ?? process.env.LOOM_SERVER_ORIGIN ?? "http://localhost:8787";
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

function mapTranscriptMessageType(role: string | undefined): LoomRunEvent["type"] {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "error";
}

function coerceAgentDepth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapTranscriptLine(runId: string, line: string, leaderName = "leader"): LoomRunEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {
      runId,
      ts: Date.now(),
      type: "error",
      summary: summarizeText(trimmed, 100),
      raw: trimmed,
    };
  }

  const ts = parseEventTimestamp(parsed.timestamp ?? parsed.ts);
  const transcriptType = typeof parsed.type === "string" ? parsed.type : undefined;
  if (transcriptType === "user") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const messageContent = message?.content;
    // Detect tool_result user frames (Claude Code sends tool returns as
    // user role with content=[{type:"tool_result", ...}]). Promote those
    // to a tool_result event instead of a blank USER row.
    if (Array.isArray(messageContent)) {
      for (const part of messageContent) {
        if (!part || typeof part !== "object") continue;
        const typedPart = part as Record<string, unknown>;
        if (typedPart.type === "tool_result") {
          const toolUseId = typeof typedPart.tool_use_id === "string" ? typedPart.tool_use_id : undefined;
          const resultText = extractMessageText(typedPart.content);
          return {
            runId,
            ts,
            type: "tool_result",
            summary: summarizeText(resultText ?? (toolUseId ? `result ${toolUseId.slice(0, 8)}` : "tool result"), 120),
            agentName: leaderName,
            agentDepth: coerceAgentDepth(parsed.agentDepth ?? parsed.agent_depth),
            agentKind: "claude",
            raw: parsed,
          };
        }
      }
    }
    const fallbackContent = typeof parsed.content === "string" ? parsed.content : undefined;
    const summary = summarizeText(extractMessageText(messageContent) ?? fallbackContent);
    if (!summary) return null;
    return {
      runId,
      ts,
      type: "user",
      summary,
      agentName: leaderName,
      agentDepth: coerceAgentDepth(parsed.agentDepth ?? parsed.agent_depth),
      agentKind: "claude",
      raw: parsed,
    };
  }
  if (transcriptType === "assistant") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const role = typeof message?.role === "string" ? message.role : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const agentName = typeof parsed.agentName === "string"
      ? parsed.agentName
      : typeof parsed.agent_name === "string"
        ? parsed.agent_name
        : leaderName;
    const agentDepth = coerceAgentDepth(parsed.parentUuid ? 1 : parsed.agentDepth ?? parsed.agent_depth);

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typedPart = part as Record<string, unknown>;
      const partType = typeof typedPart.type === "string" ? typedPart.type : undefined;
      if (partType === "tool_use") {
        const toolName = typeof typedPart.name === "string" ? typedPart.name : undefined;
        const input = (typedPart.input ?? {}) as Record<string, unknown>;
        let toolDetail: string | undefined;
        if (toolName === "Agent") {
          const subagent = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
          const desc = typeof input.description === "string" ? input.description : undefined;
          if (subagent && desc) toolDetail = `${subagent} — ${desc}`;
          else if (subagent) toolDetail = subagent;
          else if (desc) toolDetail = desc;
        } else if (toolName === "Bash") {
          const cmd = typeof input.command === "string" ? input.command : undefined;
          if (cmd) toolDetail = cmd;
        }
        const summaryText = toolName
          ? (toolDetail ? `${toolName}: ${toolDetail}` : `tool ${toolName}`)
          : "tool use";
        return {
          runId,
          ts,
          type: "tool_use",
          summary: summarizeText(summaryText, 140),
          toolName,
          agentName,
          agentDepth,
          agentKind: "claude",
          raw: parsed,
        };
      }
      if (partType === "tool_result") {
        const toolUseId = typeof typedPart.tool_use_id === "string" ? typedPart.tool_use_id : undefined;
        return {
          runId,
          ts,
          type: "tool_result",
          summary: summarizeText(toolUseId ? `result ${toolUseId}` : "tool result", 100),
          agentName,
          agentDepth,
          agentKind: "claude",
          raw: parsed,
        };
      }
      if (partType === "text") {
        const textSummary = summarizeText(typeof typedPart.text === "string" ? typedPart.text : undefined);
        if (!textSummary) continue;
        return {
          runId,
          ts,
          type: mapTranscriptMessageType(role),
          summary: textSummary,
          agentName,
          agentDepth,
          agentKind: "claude",
          raw: parsed,
        };
      }
    }

    const errorText = typeof parsed.error === "string"
      ? parsed.error
      : typeof parsed.message === "string"
        ? parsed.message
        : undefined;
    const fallbackSummary = summarizeText(errorText);
    if (!fallbackSummary) return null;
    return {
      runId,
      ts,
      type: errorText ? "error" : mapTranscriptMessageType(role),
      summary: fallbackSummary,
      agentName,
      agentDepth,
      agentKind: "claude",
      raw: parsed,
    };
  }

  if (transcriptType === "attachment") {
    const attachment = parsed.attachment as Record<string, unknown> | undefined;
    const attachmentType = typeof attachment?.type === "string" ? attachment.type : undefined;
    if (attachmentType === "hook_non_blocking_error") {
      const hookName = typeof attachment?.hookName === "string" ? attachment.hookName : "hook";
      const command = typeof attachment?.command === "string" ? attachment.command : "";
      const stderr = typeof attachment?.stderr === "string" ? attachment.stderr : "";
      const exitCode = typeof attachment?.exitCode === "number" ? attachment.exitCode : undefined;
      const pieces = [hookName, exitCode !== undefined ? `exit ${exitCode}` : undefined, stderr || command].filter(Boolean);
      return {
        runId,
        ts,
        type: "error",
        summary: summarizeText(pieces.join(" · "), 160),
        toolName: `hook:${hookName}`,
        agentName: leaderName,
        agentDepth: coerceAgentDepth(parsed.agentDepth ?? parsed.agent_depth),
        agentKind: "claude",
        raw: parsed,
      };
    }
    // other attachment subtypes (deferred_tools_delta, file-history-snapshot, etc.) are noise.
    return null;
  }

  if (transcriptType === "queue-operation") {
    return {
      runId,
      ts,
      type: "user",
      summary: summarizeText(typeof parsed.content === "string" ? parsed.content : typeof parsed.operation === "string" ? parsed.operation : transcriptType, 100),
      agentName: leaderName,
      agentDepth: coerceAgentDepth(parsed.agentDepth ?? parsed.agent_depth),
      agentKind: "claude",
      raw: parsed,
    };
  }

  // Skip internal meta frames the orchestrator writes to transcript but which
  // aren't useful to a human watcher (permission-mode, system bridge, file
  // snapshots, summary blobs, etc.). Anything we don't explicitly understand
  // is dropped rather than surfaced as a bogus ERROR row.
  return null;
}

function mapCodexHeadlessLine(runId: string, line: string, leaderName = "leader"): LoomRunEvent | null {
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

function mapHeadlessStdoutLine(runId: string, line: string, agentType: AgentType, leaderName = "leader"): LoomRunEvent[] {
  if (agentType === "codex") {
    const mapped = mapCodexHeadlessLine(runId, line, leaderName);
    return mapped ? [mapped] : [];
  }
  const mapped = mapTranscriptLine(runId, line, leaderName);
  return mapped ? [mapped] : [];
}

async function postRunEvents(origin: string, runId: string, events: LoomRunEvent[]): Promise<void> {
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

async function readTranscriptEvents(runId: string, transcriptPath: string, offset: number): Promise<{ events: LoomRunEvent[]; nextOffset: number }> {
  let content: string;
  try {
    content = await readFile(transcriptPath, "utf8");
  } catch {
    return { events: [], nextOffset: offset };
  }

  if (offset >= content.length) {
    return { events: [], nextOffset: content.length };
  }

  const chunk = content.slice(offset);
  const trailingNewline = chunk.endsWith("\n");
  const lines = chunk.split("\n");
  const completeLines = trailingNewline ? lines : lines.slice(0, -1);
  const consumedLength = completeLines.reduce((total, entry) => total + entry.length + 1, 0);
  return {
    events: completeLines.map((entry) => mapTranscriptLine(runId, entry)).filter((entry): entry is LoomRunEvent => entry !== null),
    nextOffset: offset + consumedLength,
  };
}

async function collectTranscriptProjectDirs(projectsRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsRoot, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function collectTranscriptFiles(projectsRoot: string): Promise<string[]> {
  const projectDirs = await collectTranscriptProjectDirs(projectsRoot);
  const files = await Promise.all(projectDirs.map(async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(dir, entry.name));
  }));

  return files.flat().sort((a, b) => a.localeCompare(b));
}

async function createTranscriptTail(runId: string, homeDir: string, cwd: string, origin: string, rootAgentName: string): Promise<TranscriptTailState> {
  // Scope the watch to THIS cwd's project directory only. Claude Code
  // stores transcripts at `~/.claude/projects/<cwd-with-slashes-as-dashes>/<uuid>.jsonl`,
  // so watching the top-level `projects/` on the real HOME would scan every
  // previous project the user has ever touched — enormous disk/inotify cost.
  const cwdMangled = cwd.replace(/\//g, "-");
  const scopedProjectDir = path.join(homeDir, ".claude", "projects", cwdMangled);
  // Also snapshot which jsonl files already exist before the root agent starts,
  // so we ignore pre-existing session transcripts. Only files that appear
  // AFTER this function runs are treated as belonging to the current run.
  const preExistingFiles = new Set<string>();
  try {
    const entries = await readdir(scopedProjectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        preExistingFiles.add(path.join(scopedProjectDir, entry.name));
      }
    }
  } catch {
    // directory may not exist yet — created below.
  }
  const projectsRoot = scopedProjectDir;
  const offsets = new Map<string, number>();
  const discoveredFiles = new Set<string>();
  const deliveredLineKeys = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let discoveredTranscriptDir = path.join(projectsRoot, path.basename(cwd));
  let eventCount = 0;
  let polling = Promise.resolve();

  const dedupeEvents = (file: string, startOffset: number, lines: string[], events: LoomRunEvent[]): LoomRunEvent[] => {
    const deduped: LoomRunEvent[] = [];
    let offset = startOffset;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const event = events[index];
      const key = `${file}:${offset}:${line}`;
      offset += line.length + 1;
      if (deliveredLineKeys.has(key)) continue;
      deliveredLineKeys.add(key);
      deduped.push(event);
    }
    return deduped;
  };

  const readDelta = async (file: string, startOffset: number): Promise<{ events: LoomRunEvent[]; nextOffset: number }> => {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      return { events: [], nextOffset: startOffset };
    }

    if (startOffset >= content.length) {
      return { events: [], nextOffset: content.length };
    }

    const chunk = content.slice(startOffset);
    const trailingNewline = chunk.endsWith("\n");
    const lines = chunk.split("\n");
    // split("\n") always emits a trailing "" when the chunk ends with "\n",
    // and a real partial segment when it doesn't. Either way the last element
    // is NOT a complete line we should process.
    const completeLines = lines.slice(0, -1);
    const consumedLength = trailingNewline
      ? chunk.length
      : completeLines.reduce((total, entry) => total + entry.length + 1, 0);
    const mappedEvents = completeLines
      .map((entry) => mapTranscriptLine(runId, entry, rootAgentName))
      .filter((entry): entry is LoomRunEvent => entry !== null);
    const eventLines = completeLines.filter((entry) => mapTranscriptLine(runId, entry, rootAgentName) !== null);
    return {
      events: dedupeEvents(file, startOffset, eventLines, mappedEvents),
      nextOffset: startOffset + consumedLength,
    };
  };

  const listRunFiles = async (): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(projectsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(projectsRoot, entry.name))
      .filter((fullPath) => !preExistingFiles.has(fullPath))
      .sort((a, b) => a.localeCompare(b));
  };

  const pollOnce = async (): Promise<void> => {
    const files = await listRunFiles();
    for (const file of files) {
      discoveredFiles.add(file);
      discoveredTranscriptDir = path.dirname(file);
      const currentOffset = offsets.get(file) ?? 0;
      const { events, nextOffset } = await readDelta(file, currentOffset);
      offsets.set(file, nextOffset);
      if (events.length > 0) {
        eventCount += events.length;
        await postRunEvents(origin, runId, events);
      }
    }

    for (const knownFile of [...offsets.keys()]) {
      if (!files.includes(knownFile)) {
        offsets.delete(knownFile);
        discoveredFiles.delete(knownFile);
      }
    }
  };

  const queuePoll = () => {
    polling = polling.then(pollOnce).catch(() => undefined);
    return polling;
  };

  await mkdir(projectsRoot, { recursive: true });
  await queuePoll();

  try {
    watcher = watch(projectsRoot, { recursive: true }, () => {
      void queuePoll();
    });
  } catch {
    watcher = undefined;
  }

  pollTimer = setInterval(() => {
    void queuePoll();
  }, 500);
  pollTimer.unref();

  return {
    get transcriptDir() {
      return discoveredTranscriptDir;
    },
    get discoveredFiles() {
      return discoveredFiles;
    },
    get eventCount() {
      return eventCount;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      watcher?.close();
      if (pollTimer) clearInterval(pollTimer);
      await queuePoll();
    },
    flushBundle: async () => {
      await queuePoll();
    },
  };
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
    postEvents: async (events: LoomRunEvent[]) => {
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
    "<!-- Delegate only through Loom MCP delegation tools. Do not use TeamCreate, Agent(name=...), or direct loom-subagent Bash commands. -->",
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
  if (agent.type === "claude-code") {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--session-id", randomUUID(),
      "--no-session-persistence",
      "--dangerously-skip-permissions",
    ];
    if (agent.model) {
      args.push("--model", agent.model);
    }
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }
    if (finalInstructions.trim()) {
      args.push("--append-system-prompt", finalInstructions);
    }
    args.push(userPrompt);
    return { command: "claude", args };
  }

  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ];
  if (agent.model) {
    args.push("--model", agent.model);
  }
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
    LOOM_FLOW_PATH: flow.absolutePath,
    LOOM_FLOW_NAME: flow.flow.name,
    LOOM_FLOW_CWD: flowCwd,
    LOOM_AGENT: configuredAgent.name,
    LOOM_AGENT_TYPE: configuredAgent.type,
    LOOM_RUN_ID: registration.runId,
    LOOM_SERVER_ORIGIN: serverOrigin,
    LOOM_PARENT_AGENT: configuredAgent.name,
    LOOM_PARENT_DEPTH: "0",
    LOOM_SUBAGENT_BIN: fileURLToPath(new URL("./subagent-launcher.js", import.meta.url)),
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
  // The root agent runs with the host's normal config/login. Claude accepts
  // hidden prompt injection directly; Codex gets an ephemeral CODEX_HOME whose
  // AGENTS.md combines the real global AGENTS.md with this flow's instructions.
  const agent: AgentConfig = { ...flow.flow.orchestrator };
  const configuredAgent = buildConfiguredAgent(agent, flow.flow, flow.flow.repo, {
    roles: new Map(),
    hooks: new Map(),
    skills: new Map(),
  });
  const agentFlowMd = resolveAgentFlowMd(flow, configuredAgent);
  const mergedInstructions = mergeFlowMd(flow.flow.flowMd, agentFlowMd, configuredAgent);
  const flowCwd = resolveFlowCwd(flow);
  const userPrompt = await readHeadlessPrompt(options);
  if (options.headless && !userPrompt) {
    throw new Error("loom: --headless requires --prompt, --prompt-file, or piped stdin");
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
    if (configuredAgent.type === "codex") {
      headlessCodexHome = await createCodexInstructionHome({
        instructions: "",
        configAppend: leaderMcpConfig.codexConfigToml,
        writeAgents: false,
      });
      extraEnv.CODEX_HOME = headlessCodexHome.codexHome;
      extraEnv.CODEX_CONFIG_DIR = headlessCodexHome.codexHome;
    }
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
        configuredAgent.type === "claude-code" ? leaderMcpConfig.claudeConfigPath : undefined,
      );
    } finally {
      await headlessCodexHome?.cleanup().catch(() => undefined);
      await leaderMcpConfig.cleanup().catch(() => undefined);
    }
  }

  const { command, args } = buildSpawnArgs(configuredAgent);
  let codexInstructionHome: CodexInstructionHome | undefined;
  if (configuredAgent.type === "claude-code" && finalInstructions.trim().length > 0) {
    args.push("--append-system-prompt", finalInstructions);
  }
  if (configuredAgent.type === "claude-code") {
    args.push("--mcp-config", leaderMcpConfig.claudeConfigPath);
  }
  if (configuredAgent.type === "codex") {
    codexInstructionHome = await createCodexInstructionHome({
      instructions: finalInstructions,
      configAppend: leaderMcpConfig.codexConfigToml,
    });
  }

  const realHome = os.homedir();
  const transcriptTail = configuredAgent.type === "claude-code"
    ? await createTranscriptTail(registration.runId, realHome, flowCwd, getServerOrigin(options.serverOrigin), configuredAgent.name)
    : undefined;
  const finalizeRun = async (exitCode: number) => {
    if (transcriptTail) {
      await transcriptTail.close();
      await transcriptTail.flushBundle();
    }
    await codexInstructionHome?.cleanup().catch(() => undefined);
    await leaderMcpConfig.cleanup().catch(() => undefined);
    await registration.cleanup(exitCode);
  };

  // Hand the TTY back to the child cleanly: readline may have left stdin
  // in raw mode with bracketed-paste/mouse tracking off, which breaks
  // ctrl+v, arrow keys, etc. when claude takes over with stdio:inherit.
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
      LOOM_FLOW_PATH: flow.absolutePath,
      LOOM_FLOW_NAME: flow.flow.name,
      LOOM_FLOW_CWD: flowCwd,
      LOOM_AGENT: agent.name,
      LOOM_AGENT_TYPE: agent.type,
      LOOM_RUN_ID: registration.runId,
      LOOM_SERVER_ORIGIN: getServerOrigin(options.serverOrigin),
      LOOM_PARENT_AGENT: configuredAgent.name,
      LOOM_PARENT_DEPTH: "0",
      LOOM_SUBAGENT_BIN: fileURLToPath(new URL("./subagent-launcher.js", import.meta.url)),
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
  type: claude-code
  runtime:
    mode: host
    profile: claude-default
    applyResources: prompt-only
    delegationTransport: mcp
  model: claude-opus-4-7
  system: |
    You are the orchestrator for ${name}. Delegate work to your team.
  effort: xhigh
  delegation: []
  agents: []
`;
}

async function createNewFlowInteractive(rl: readline.Interface): Promise<string> {
  const rawName = (await rl.question("New flow name: ")).trim();
  if (!rawName) throw new Error("Flow name is required");
  const slug = slugify(rawName) || `flow-${Date.now()}`;
  const targetDir = path.join(workspaceRoot, "examples");
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
      const created = await createNewFlowInteractive(rl);
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
    await runLoomMcpServer({
      env: {
        ...process.env,
        LOOM_SUBAGENT_BIN: process.env.LOOM_SUBAGENT_BIN ?? fileURLToPath(new URL("./subagent-launcher.js", import.meta.url)),
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
    throw new Error("loom: --headless requires --flow <path>");
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
    throw new Error("loom: interactive flow selection requires a TTY. Pass --flow <path> or a positional flow path to skip the prompt.");
  }

  const selection = await promptForSelection(flows);
  if (selection.kind === "created") {
    console.log(`\nCreated ${selection.absolutePath}`);
    console.log("Edit the flow YAML then run 'loom' again to launch it.");
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
