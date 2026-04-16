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
import type { AgentConfig, AgentType, HookDefinition, SkillDefinition } from "@loom/core";
import {
  loadFlow,
  createScopedMcpConfig,
  loadHookDefinitions,
  loadSkillDefinitions,
  resolveAgentResources,
} from "../../../apps/server/dist/runner.js";
import { buildConfiguredAgent } from "../../../apps/server/dist/runner-prompt-builder.js";

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
  postEvents: (events: LoomRunEvent[]) => Promise<void>;
}

interface LoomRunEvent {
  runId: string;
  ts: number;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "error";
  summary?: string;
  toolName?: string;
  agentName?: string;
  agentDepth?: number;
  raw: unknown;
}

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

  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  if (agent.model) {
    args.push("-m", agent.model);
  }
  return { command: "codex", args };
}

function getServerOrigin(): string {
  return process.env.LOOM_SERVER_ORIGIN ?? "http://localhost:8787";
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

function mapTranscriptLine(runId: string, line: string): LoomRunEvent | null {
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
    const fallbackContent = typeof parsed.content === "string" ? parsed.content : undefined;
    return {
      runId,
      ts,
      type: "user",
      summary: summarizeText(extractMessageText(message?.content) ?? fallbackContent),
      agentName: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      agentDepth: coerceAgentDepth(parsed.agentDepth ?? parsed.agent_depth),
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
        : typeof parsed.sessionId === "string"
          ? parsed.sessionId
          : undefined;
    const agentDepth = coerceAgentDepth(parsed.parentUuid ? 1 : parsed.agentDepth ?? parsed.agent_depth);

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typedPart = part as Record<string, unknown>;
      const partType = typeof typedPart.type === "string" ? typedPart.type : undefined;
      if (partType === "tool_use") {
        return {
          runId,
          ts,
          type: "tool_use",
          summary: summarizeText(typeof typedPart.name === "string" ? `tool ${typedPart.name}` : "tool use", 100),
          toolName: typeof typedPart.name === "string" ? typedPart.name : undefined,
          agentName,
          agentDepth,
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
          raw: parsed,
        };
      }
      if (partType === "text") {
        return {
          runId,
          ts,
          type: mapTranscriptMessageType(role),
          summary: summarizeText(typeof typedPart.text === "string" ? typedPart.text : undefined),
          agentName,
          agentDepth,
          raw: parsed,
        };
      }
    }

    const errorText = typeof parsed.error === "string"
      ? parsed.error
      : typeof parsed.message === "string"
        ? parsed.message
        : undefined;
    return {
      runId,
      ts,
      type: errorText ? "error" : mapTranscriptMessageType(role),
      summary: summarizeText(errorText),
      agentName,
      agentDepth,
      raw: parsed,
    };
  }

  const queueSummary = transcriptType === "queue-operation"
    ? summarizeText(typeof parsed.content === "string" ? parsed.content : typeof parsed.operation === "string" ? parsed.operation : transcriptType, 100)
    : undefined;
  return {
    runId,
    ts,
    type: transcriptType === "queue-operation" ? "user" : "error",
    summary: queueSummary,
    agentName: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
    agentDepth: coerceAgentDepth(parsed.agentDepth ?? parsed.agent_depth),
    raw: parsed,
  };
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

async function createTranscriptTail(runId: string, isolatedHome: string, cwd: string, origin: string): Promise<TranscriptTailState> {
  const projectsRoot = path.join(isolatedHome, ".claude", "projects");
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
    const completeLines = trailingNewline ? lines : lines.slice(0, -1);
    const consumedLength = completeLines.reduce((total, entry) => total + entry.length + 1, 0);
    const mappedEvents = completeLines
      .map((entry) => mapTranscriptLine(runId, entry))
      .filter((entry): entry is LoomRunEvent => entry !== null);
    const eventLines = completeLines.filter((entry) => mapTranscriptLine(runId, entry) !== null);
    return {
      events: dedupeEvents(file, startOffset, eventLines, mappedEvents),
      nextOffset: startOffset + consumedLength,
    };
  };

  const pollOnce = async (): Promise<void> => {
    const files = await collectTranscriptFiles(projectsRoot);
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
        cwd: resolveFlowCwd(flow),
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

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

const CLAUDE_GLOBAL_CUSTOM_KEYS = new Set<string>([
  "mcpServers",
  "projects",
  "skillUsage",
  "officialMarketplaceAutoInstallAttempted",
  "officialMarketplaceAutoInstalled",
  "githubRepoPaths",
]);

const CLAUDE_SETTINGS_CARRYOVER_KEYS = [
  "statusLine",
  "language",
  "effortLevel",
  "autoDreamEnabled",
  "skipDangerousModePermissionPrompt",
] as const;

const CLAUDE_PROJECT_STATE_KEYS = [
  "hasTrustDialogAccepted",
  "projectOnboardingSeenCount",
  "hasClaudeMdExternalIncludesApproved",
  "hasClaudeMdExternalIncludesWarningShown",
  "exampleFiles",
] as const;

const CLAUDE_DEFAULT_THEME = "dark";
const CLAUDE_ONBOARDING_VERSION_LOCK = "99.99.99";

const CLAUDE_HOOK_EVENT_MAP: Record<HookDefinition["event"], string> = {
  on_start: "SessionStart",
  on_complete: "Stop",
  on_error: "SubagentStop",
  on_delegate: "Notification",
};

function stripGlobalCustomKeys(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !CLAUDE_GLOBAL_CUSTOM_KEYS.has(key)));
}

function copyDefinedKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) copied[key] = source[key];
  }
  return copied;
}

async function writeClaudeSkillFiles(claudeDir: string, skills: SkillDefinition[]): Promise<void> {
  if (skills.length === 0) {
    return;
  }
  const skillsRoot = path.join(claudeDir, "skills");
  await mkdir(skillsRoot, { recursive: true });
  await Promise.all(skills.map(async (skill) => {
    const skillDir = path.join(skillsRoot, skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), skill.prompt, "utf8");
  }));
}

function buildClaudeHooksConfig(hooks: HookDefinition[]): Record<string, Array<{ matcher: string; hooks: Array<{ type: "command"; command: string }> }>> {
  const grouped: Record<string, Array<{ matcher: string; hooks: Array<{ type: "command"; command: string }> }>> = {};
  for (const hook of hooks) {
    const event = CLAUDE_HOOK_EVENT_MAP[hook.event];
    grouped[event] ??= [];
    grouped[event].push({
      matcher: "",
      hooks: [{ type: "command", command: hook.command }],
    });
  }
  return grouped;
}

async function createIsolatedHome(
  systemPrompt: string,
  flowClaudeMd: string | undefined,
  agentClaudeMd: string | undefined,
  configuredAgent: AgentConfig,
  flowCwd: string,
  scopedHooks: HookDefinition[],
  scopedSkills: SkillDefinition[],
): Promise<string> {
  const loomHomesRoot = path.join(os.homedir(), ".loom", "homes");
  await mkdir(loomHomesRoot, { recursive: true });
  const isolatedHome = await mkdtemp(path.join(loomHomesRoot, "run-"));
  const mergedInstructions = mergeClaudeMd(flowClaudeMd, agentClaudeMd, configuredAgent);
  const realHome = os.homedir();

  if (configuredAgent.type === "claude-code") {
    const claudeDir = path.join(isolatedHome, ".claude");
    await mkdir(claudeDir, { recursive: true });

    const realCredentials = await readOptional(path.join(realHome, ".claude", ".credentials.json"));
    if (realCredentials) {
      await writeFile(path.join(claudeDir, ".credentials.json"), realCredentials, { encoding: "utf8", mode: 0o600 });
    }

    const realClaudeJsonRaw = await readOptional(path.join(realHome, ".claude.json"));
    let filteredClaudeJson: Record<string, unknown> = {
      env: {},
      permissions: { allow: [] },
      theme: CLAUDE_DEFAULT_THEME,
      lastOnboardingVersion: CLAUDE_ONBOARDING_VERSION_LOCK,
    };
    if (realClaudeJsonRaw) {
      try {
        const realClaudeJson = JSON.parse(realClaudeJsonRaw) as Record<string, unknown>;
        const realProjects = realClaudeJson.projects && typeof realClaudeJson.projects === "object"
          ? realClaudeJson.projects as Record<string, Record<string, unknown>>
          : {};
        const sourceProject = realProjects[workspaceRoot] && typeof realProjects[workspaceRoot] === "object"
          ? realProjects[workspaceRoot]
          : undefined;
        filteredClaudeJson = {
          ...stripGlobalCustomKeys(realClaudeJson),
          theme: typeof realClaudeJson.theme === "string" ? realClaudeJson.theme : CLAUDE_DEFAULT_THEME,
          ...copyDefinedKeys(realClaudeJson, ["syntaxHighlightingDisabled"]),
          env: {},
          permissions: { allow: [] },
          lastOnboardingVersion: CLAUDE_ONBOARDING_VERSION_LOCK,
          projects: sourceProject
            ? {
                [flowCwd]: copyDefinedKeys(sourceProject, CLAUDE_PROJECT_STATE_KEYS),
              }
            : {},
        };
      } catch {
        filteredClaudeJson = {
          env: {},
          permissions: { allow: [] },
          theme: CLAUDE_DEFAULT_THEME,
          lastOnboardingVersion: CLAUDE_ONBOARDING_VERSION_LOCK,
        };
      }
    }
    await writeFile(path.join(isolatedHome, ".claude.json"), JSON.stringify(filteredClaudeJson, null, 2), { encoding: "utf8", mode: 0o600 });

    // settings.json filtered: drop global hooks/plugins/marketplaces, then inject only flow-scoped hooks.
    const realSettingsRaw = await readOptional(path.join(realHome, ".claude", "settings.json"));
    const filteredSettings: Record<string, unknown> = { env: {}, permissions: { allow: [] } };
    if (realSettingsRaw) {
      try {
        const real = JSON.parse(realSettingsRaw) as Record<string, unknown>;
        Object.assign(filteredSettings, copyDefinedKeys(real, CLAUDE_SETTINGS_CARRYOVER_KEYS));
      } catch { /* ignore */ }
    }
    if (scopedHooks.length > 0) {
      filteredSettings.hooks = buildClaudeHooksConfig(scopedHooks);
    }
    await writeFile(path.join(claudeDir, "settings.json"), JSON.stringify(filteredSettings, null, 2), "utf8");

    await writeClaudeSkillFiles(claudeDir, scopedSkills);

    const realDashboard = await readOptional(path.join(realHome, ".claude", "claude-dashboard.local.json"));
    if (realDashboard) {
      await writeFile(path.join(claudeDir, "claude-dashboard.local.json"), realDashboard, "utf8");
    }

    await writeFile(path.join(claudeDir, "CLAUDE.md"), mergedInstructions, "utf8");
  } else {
    const codexDir = path.join(isolatedHome, ".codex");
    await mkdir(codexDir, { recursive: true });
    const realAuth = await readOptional(path.join(realHome, ".codex", "auth.json"));
    if (realAuth) {
      await writeFile(path.join(codexDir, "auth.json"), realAuth, "utf8");
    }
    await writeFile(path.join(codexDir, "AGENTS.md"), mergedInstructions, "utf8");
    await writeFile(
      path.join(codexDir, "config.toml"),
      `# Loom-generated Codex config (isolated)\n`,
      "utf8",
    );
  }
  return isolatedHome;
}

async function launchAgent(flow: LoadedCliFlow): Promise<number> {
  const agent: AgentConfig = { ...flow.flow.orchestrator } as AgentConfig & { isolated: true };
  const [hookDefinitions, skillDefinitions] = await Promise.all([
    loadHookDefinitions(),
    loadSkillDefinitions(),
  ]);
  const scopedResources = resolveAgentResources(agent, flow.flow);
  const scopedHooks = scopedResources.hooks
    .map((name) => hookDefinitions.get(name))
    .filter((hook): hook is HookDefinition => Boolean(hook));
  const scopedSkills = scopedResources.skills
    .map((name) => skillDefinitions.get(name))
    .filter((skill): skill is SkillDefinition => Boolean(skill));
  const configuredAgent = buildConfiguredAgent(agent, flow.flow, flow.flow.repo, {
    roles: new Map(),
    hooks: new Map(scopedHooks.map((hook) => [hook.name, hook])),
    skills: new Map(scopedSkills.map((skill) => [skill.name, skill])),
  });
  const systemPrompt = configuredAgent.system ?? "";
  const agentClaudeMd = resolveAgentClaudeMd(flow, configuredAgent);
  const mergedInstructions = mergeClaudeMd(flow.flow.claudeMd, agentClaudeMd, configuredAgent);
  const flowCwd = resolveFlowCwd(flow);
  const isolatedHome = await createIsolatedHome(systemPrompt, flow.flow.claudeMd, agentClaudeMd, configuredAgent, flowCwd, scopedHooks, scopedSkills);
  const scopedMcpConfigPath = await createScopedMcpConfig(agent, flow.flow, isolatedHome);
  const registration = await reportCliRunStart(flow, configuredAgent.type);
  const transcriptTail = configuredAgent.type === "claude-code"
    ? await createTranscriptTail(registration.runId, isolatedHome, flowCwd, getServerOrigin())
    : undefined;
  const finalizeRun = async (exitCode: number) => {
    if (transcriptTail) {
      await transcriptTail.close();
      await transcriptTail.flushBundle();
    }
    await registration.cleanup(exitCode);
    if (scopedMcpConfigPath) {
      await rm(path.dirname(scopedMcpConfigPath), { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(isolatedHome, { recursive: true, force: true }).catch(() => undefined);
  };
  const { command, args } = buildSpawnArgs(configuredAgent);
  // Inject flow claudeMd into claude via --append-system-prompt so the real
  // HOME stays untouched (no re-login / onboarding).
  if (configuredAgent.type === "claude-code") {
    if (mergedInstructions.trim().length > 0) {
      args.push("--append-system-prompt", mergedInstructions);
    }
    // MCP isolation: only the flow-scoped MCPs (if any), otherwise none.
    args.push("--strict-mcp-config");
    if (scopedMcpConfigPath) {
      args.push("--mcp-config", scopedMcpConfigPath);
    }
  }
  const litellmEnv = configuredAgent.type === "claude-code" && configuredAgent.model?.startsWith("chatgpt/")
    ? {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
        ANTHROPIC_AUTH_TOKEN: "dummy-token",
      }
    : {};

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
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      PATH: process.env.PATH ?? "",
      XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
      CODEX_HOME: path.join(isolatedHome, ".codex"),
      CODEX_CONFIG_DIR: path.join(isolatedHome, ".codex"),
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      CLAUDE_CODE_TEAMMATE_COMMAND: "/home/argoss/.claude/codex-bridge/codex-bridge.mjs",
      LOOM_FLOW_PATH: flow.absolutePath,
      LOOM_FLOW_NAME: flow.flow.name,
      ...litellmEnv,
      ...(scopedMcpConfigPath ? { LOOM_MCP_CONFIG_PATH: scopedMcpConfigPath } : {}),
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
claudeMd: |
  # Flow Common Policy
  - 범위 엄수. 인접 불가침. 가정 명시.
claudeMdLibrary: {}
orchestrator:
  name: leader
  type: claude-code
  model: claude-opus-4-6
  system: |
    You are the orchestrator for ${name}. Delegate work to your team.
  effort: high
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
    console.log("No flow YAML files found. Launching flow-creation prompt.\n");
  }
  const selection = await promptForSelection(flows);
  if (selection.kind === "created") {
    console.log(`\nCreated ${selection.absolutePath}`);
    console.log("Edit the flow YAML then run 'loom' again to launch it.");
    return;
  }
  const exitCode = await launchAgent(selection.flow);
  process.exitCode = exitCode;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
