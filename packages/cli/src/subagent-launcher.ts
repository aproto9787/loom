#!/usr/bin/env node

// loom-subagent: generalized headless executor. Loom MCP invokes this internal
// runtime to execute a BRIEFING in an isolated child agent. The child runs
// claude or codex, streams every tool_use / tool_result / assistant frame back
// to the server tagged with this subagent's name and parent, and writes a
// REPORT to stdout / file.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { AgentConfig, FlowDefinition, HookDefinition, SkillDefinition } from "@aproto9787/loom-core";
import {
  buildConfiguredAgent,
  createScopedMcpConfig,
  loadHookDefinitions,
  loadSkillDefinitions,
  findAgentByName,
  resolveAgentResources,
} from "@aproto9787/loom-runtime";
import { buildDelegationPrompt } from "./delegation-prompt.js";

type Backend = "claude" | "codex";
type LoomEventType = "tool_use" | "tool_result" | "user" | "assistant" | "error";

interface CliArgs {
  name: string;
  backend: Backend;
  model?: string;
  parentAgent: string;
  parentDepth: number;
  maxSeconds: number;
  reportPath?: string;
  briefingFile?: string;
  briefing: string;
}

const RUN_ID = process.env.LOOM_RUN_ID;
const SERVER_ORIGIN = process.env.LOOM_SERVER_ORIGIN ?? "http://localhost:8787";
const DEFAULT_REPORT_DIR = path.join(os.tmpdir(), "loom-subagent");
const REPORT_POLL_MS = 500;
const REPORT_STABLE_MS = 1000;
const REPORT_SHUTDOWN_GRACE_MS = 3000;

function printUsage(): void {
  console.error(`loom-subagent — generalized child-agent runner for Loom flows

Usage:
  loom-subagent --name <role> --backend claude|codex [options] --briefing "Review the changed files"
  loom-subagent --name <role> --backend claude|codex [options] -- "Briefing that may start with --"
  printf '%s\n' "Review the changed files" | loom-subagent --name <role> --backend <claude|codex> [options]

Options:
  --name <role>          child agent display name (required)
  --backend <kind>       claude | codex (required)
  --model <id>           model override (default: backend default)
  --parent <name>        parent agent name (default: env LOOM_PARENT_AGENT or "leader")
  --depth <n>            parent depth (default: env LOOM_PARENT_DEPTH or 0)
  --max-seconds <n>      hard timeout (default: 900)
  --report <path>        explicit REPORT file path
  --briefing <text>      explicit task briefing; safest for one-line delegated tasks
  --briefing-file <path> read task briefing from a file; useful for long/multiline tasks

Environment:
  LOOM_RUN_ID            run id to POST events to (required to stream)
  LOOM_SERVER_ORIGIN     server origin (default: http://localhost:8787)
  LOOM_PARENT_AGENT      fallback parent name
  LOOM_PARENT_DEPTH      fallback parent depth
`);
}

function parseArgs(argv: string[]): CliArgs | null {
  const args: Record<string, string | undefined> = {};
  const positional: string[] = [];
  const optionsWithValues = new Set([
    "name",
    "backend",
    "model",
    "parent",
    "depth",
    "max-seconds",
    "report",
    "briefing",
    "briefing-file",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur === "--help" || cur === "-h") {
      printUsage();
      process.exit(0);
    }
    if (cur === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (cur.startsWith("--")) {
      const equalIndex = cur.indexOf("=");
      if (equalIndex > 2) {
        const key = cur.slice(2, equalIndex);
        if (!optionsWithValues.has(key)) {
          console.error(`loom-subagent: unknown option --${key}`);
          printUsage();
          return null;
        }
        args[key] = cur.slice(equalIndex + 1);
        continue;
      }

      const key = cur.slice(2);
      if (!optionsWithValues.has(key)) {
        console.error(`loom-subagent: unknown option --${key}`);
        printUsage();
        return null;
      }

      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && key !== "briefing")) {
        args[key] = "";
      } else {
        args[key] = next;
        i++;
      }
    } else {
      positional.push(cur);
    }
  }

  const name = args.name;
  const backendRaw = args.backend;
  if (!name || (backendRaw !== "claude" && backendRaw !== "codex")) {
    printUsage();
    return null;
  }

  const explicitBriefing = args.briefing?.trim();
  return {
    name,
    backend: backendRaw,
    model: args.model,
    parentAgent: args.parent ?? process.env.LOOM_PARENT_AGENT ?? "leader",
    parentDepth: Number(args.depth ?? process.env.LOOM_PARENT_DEPTH ?? "0"),
    maxSeconds: Number(args["max-seconds"] ?? "900"),
    reportPath: args.report,
    briefingFile: args["briefing-file"],
    briefing: explicitBriefing || positional.join(" ").trim(),
  };
}

async function readBriefing(fromArg: string, fromFile?: string): Promise<string> {
  const argBriefing = fromArg.trim();
  if (argBriefing) return argBriefing;

  const filePath = fromFile?.trim();
  if (filePath) {
    return (await readFile(path.resolve(filePath), "utf8")).trim();
  }

  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function truncate(value: string, max = 160): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function initialReport(name: string): string {
  return `status: blocked\nsummary:\n  - ${name} did not start\n`;
}

function isCompleteReport(report: string, args: CliArgs): boolean {
  const trimmed = report.trim();
  if (!trimmed || trimmed === initialReport(args.name).trim()) {
    return false;
  }

  return /^status:\s*(done|blocked|needs_decision)\s*$/m.test(report)
    && /^summary:\s*$/m.test(report)
    && /^\s*-\s+\S/m.test(report);
}

async function postEvent(
  args: CliArgs,
  type: LoomEventType,
  summary: string,
  extra: { toolName?: string } = {},
): Promise<void> {
  if (!RUN_ID) return;
  const depth = args.parentDepth + 1;
  try {
    await fetch(`${SERVER_ORIGIN}/runs/${encodeURIComponent(RUN_ID)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{
          ts: Date.now(),
          type,
          summary,
          toolName: extra.toolName,
          agentName: args.name,
          agentDepth: depth,
          parentAgent: args.parentAgent,
          agentKind: args.backend,
        }],
      }),
    });
  } catch {
    // best effort
  }
}

interface MappedEvent {
  type: LoomEventType;
  summary: string;
  toolName?: string;
}

function mapCodexItem(item: Record<string, unknown>): MappedEvent | null {
  const itemType = typeof item.type === "string" ? item.type : undefined;
  if (!itemType) return null;
  switch (itemType) {
    case "agent_message": {
      const text = typeof item.text === "string" ? item.text : "";
      if (!text.trim()) return null;
      return { type: "assistant", summary: truncate(text) };
    }
    case "reasoning": {
      const text = typeof item.text === "string" ? item.text : "";
      if (!text.trim()) return null;
      return { type: "assistant", summary: truncate(`reasoning: ${text}`), toolName: "reasoning" };
    }
    case "command_execution": {
      const cmd = typeof item.command === "string" ? item.command : "command";
      return { type: "tool_use", summary: truncate(cmd), toolName: "Bash" };
    }
    case "file_change": {
      const pathStr = typeof item.path === "string" ? item.path : "";
      const op = typeof item.operation === "string" ? item.operation : "edit";
      return { type: "tool_result", summary: truncate(`${op} ${pathStr}`), toolName: "Edit" };
    }
    default: {
      const summary = typeof (item as { summary?: unknown }).summary === "string"
        ? (item as { summary: string }).summary
        : itemType;
      return { type: "tool_use", summary: truncate(summary), toolName: itemType };
    }
  }
}

function mapClaudeFrame(frame: Record<string, unknown>): MappedEvent[] {
  const results: MappedEvent[] = [];
  const frameType = typeof frame.type === "string" ? frame.type : undefined;
  if (!frameType) return results;
  if (frameType === "assistant") {
    const message = frame.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typedPart = part as Record<string, unknown>;
      const partType = typeof typedPart.type === "string" ? typedPart.type : undefined;
      if (partType === "text") {
        const text = typeof typedPart.text === "string" ? typedPart.text : "";
        if (text.trim()) results.push({ type: "assistant", summary: truncate(text) });
      } else if (partType === "tool_use") {
        const toolName = typeof typedPart.name === "string" ? typedPart.name : undefined;
        const input = (typedPart.input ?? {}) as Record<string, unknown>;
        let detail: string | undefined;
        if (toolName === "Bash") {
          const cmd = typeof input.command === "string" ? input.command : undefined;
          if (cmd) detail = cmd;
        } else if (toolName === "Agent") {
          const sub = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
          const desc = typeof input.description === "string" ? input.description : undefined;
          detail = sub && desc ? `${sub} — ${desc}` : sub ?? desc;
        }
        const summary = toolName
          ? (detail ? `${toolName}: ${detail}` : `tool ${toolName}`)
          : "tool use";
        results.push({ type: "tool_use", summary: truncate(summary), toolName });
      }
    }
  } else if (frameType === "user") {
    const message = frame.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typedPart = part as Record<string, unknown>;
      if (typedPart.type === "tool_result") {
        const raw = typedPart.content;
        let text: string;
        if (typeof raw === "string") text = raw;
        else if (Array.isArray(raw)) {
          text = raw
            .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
              ? (p as { text: string }).text
              : ""))
            .filter(Boolean)
            .join(" ");
        } else text = "tool result";
        results.push({ type: "tool_result", summary: truncate(text, 140) });
      }
    }
  } else if (frameType === "result") {
    const subtype = typeof frame.subtype === "string" ? frame.subtype : "result";
    const result = typeof frame.result === "string" ? frame.result : "";
    if (result.trim()) {
      results.push({
        type: subtype === "success" ? "assistant" : "error",
        summary: truncate(result, 200),
      });
    }
  } else if (frameType === "system") {
    // Only surface the init frame (once per session). Hook lifecycle frames
    // (hook_started / hook_response / etc.) are debugging noise — never
    // meaningful to a timeline viewer, they just clutter every run.
    const subtype = typeof frame.subtype === "string" ? frame.subtype : "system";
    if (subtype === "init") {
      results.push({ type: "assistant", summary: `session:init`, toolName: "system" });
    }
  } else if (frameType === "rate_limit_event" || frameType === "message_delta" || frameType === "message_start" || frameType === "message_stop" || frameType === "content_block_start" || frameType === "content_block_delta" || frameType === "content_block_stop" || frameType === "ping") {
    // Known infrastructure frames that carry no user-facing signal.
    // Dropping them keeps the timeline focused on actual tool use + text.
  } else {
    // Truly unmapped frame type — surface it once so a future gap is visible.
    const preview = truncate(JSON.stringify(frame), 120);
    results.push({ type: "tool_use", summary: `stream-json:${frameType} ${preview}`, toolName: `claude:${frameType}` });
  }
  return results;
}

interface FlowContext {
  flow: FlowDefinition;
  selfAgent: AgentConfig;
}

async function loadFlowContext(selfName: string): Promise<FlowContext | undefined> {
  const flowPath = process.env.LOOM_FLOW_PATH;
  if (!flowPath) return undefined;
  try {
    const raw = await readFile(flowPath, "utf8");
    const parsed = YAML.parse(raw) as FlowDefinition | undefined;
    if (!parsed?.orchestrator) return undefined;
    const found = findAgentByName(parsed.orchestrator, selfName);
    if (!found) return undefined;
    return { flow: parsed, selfAgent: found };
  } catch {
    return undefined;
  }
}

// Minimal helpers duplicated from packages/cli/src/index.ts createIsolatedHome.
// Subagent is headless (--print / codex exec) so it skips the interactive
// onboarding carryover the leader needs — just credentials, hooks, skills,
// and merged flow.md / AGENTS.md.
async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

const CLAUDE_HOOK_EVENT_MAP: Record<HookDefinition["event"], string> = {
  on_start: "SessionStart",
  on_complete: "Stop",
  on_error: "SubagentStop",
  on_delegate: "Notification",
};

function buildHooksConfig(hooks: HookDefinition[]): Record<string, Array<{ matcher: string; hooks: Array<{ type: "command"; command: string }> }>> {
  const grouped: Record<string, Array<{ matcher: string; hooks: Array<{ type: "command"; command: string }> }>> = {};
  for (const hook of hooks) {
    const event = CLAUDE_HOOK_EVENT_MAP[hook.event];
    grouped[event] ??= [];
    grouped[event].push({ matcher: "", hooks: [{ type: "command", command: hook.command }] });
  }
  return grouped;
}

async function writeSkillFiles(claudeDir: string, skills: SkillDefinition[]): Promise<void> {
  if (skills.length === 0) return;
  const skillsRoot = path.join(claudeDir, "skills");
  await mkdir(skillsRoot, { recursive: true });
  await Promise.all(skills.map(async (skill) => {
    const skillDir = path.join(skillsRoot, skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), skill.prompt, "utf8");
  }));
}

function mergeInstructions(flowFlowMd: string | undefined, agentFlowMd: string | undefined, system: string | undefined): string {
  return [flowFlowMd?.trim(), agentFlowMd?.trim(), system?.trim()].filter(Boolean).join("\n\n");
}

async function createSubagentHome(
  args: CliArgs,
  flow: FlowDefinition,
  configuredAgent: AgentConfig,
  scopedHooks: HookDefinition[],
  scopedSkills: SkillDefinition[],
  codexConfigAppend?: string,
): Promise<string> {
  const root = path.join(os.homedir(), ".loom", "subagent-homes");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, `${args.name}-`));
  const realHome = os.homedir();
  const agentFlowMd = configuredAgent.flowMdRef
    ? flow.flowMdLibrary?.[configuredAgent.flowMdRef]
    : undefined;
  const merged = mergeInstructions(flow.flowMd, agentFlowMd, configuredAgent.system);

  if (args.backend === "claude") {
    const claudeDir = path.join(home, ".claude");
    await mkdir(claudeDir, { recursive: true });

    const realCreds = await readOptional(path.join(realHome, ".claude", ".credentials.json"));
    if (realCreds) {
      await writeFile(path.join(claudeDir, ".credentials.json"), realCreds, { encoding: "utf8", mode: 0o600 });
    }
    // Headless `--print --no-session-persistence` doesn't require the big
    // onboarding shape — a minimal .claude.json is enough.
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, env: {}, permissions: { allow: [] } }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );

    const settings: Record<string, unknown> = { env: {}, permissions: { allow: [] } };
    if (scopedHooks.length > 0) settings.hooks = buildHooksConfig(scopedHooks);
    await writeFile(path.join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");

    await writeSkillFiles(claudeDir, scopedSkills);
    if (merged.trim()) {
      // Loom models this content as flow.md, but Claude Code discovers it
      // through its backend-specific CLAUDE.md filename.
      await writeFile(path.join(claudeDir, "CLAUDE.md"), merged, "utf8");
    }
  } else {
    const codexDir = path.join(home, ".codex");
    await mkdir(codexDir, { recursive: true });
    const realAuth = await readOptional(path.join(realHome, ".codex", "auth.json"));
    if (realAuth) {
      await writeFile(path.join(codexDir, "auth.json"), realAuth, { encoding: "utf8", mode: 0o600 });
    }
    const realConfig = await readOptional(path.join(realHome, ".codex", "config.toml"));
    const configParts = [realConfig ?? "# Loom-seeded (empty)\n"];
    if (codexConfigAppend?.trim()) {
      configParts.push(codexConfigAppend.trim());
    }
    await writeFile(
      path.join(codexDir, "config.toml"),
      `${configParts.map((part) => part.trimEnd()).join("\n\n")}\n`,
      "utf8",
    );
    if (merged.trim()) {
      await writeFile(path.join(codexDir, "AGENTS.md"), merged, "utf8");
    }
  }
  return home;
}

interface LoomMcpConfig {
  claudeConfigPath: string;
  codexConfigToml: string;
  cleanup: () => Promise<void>;
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

function compactEnv(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function createLoomMcpConfig(args: CliArgs, flow: FlowDefinition, configuredAgent: AgentConfig): Promise<LoomMcpConfig> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-subagent-mcp-"));
  const cliBin = fileURLToPath(new URL("./index.js", import.meta.url));
  const subagentBin = fileURLToPath(new URL("./subagent-launcher.js", import.meta.url));
  const env = compactEnv({
    LOOM_FLOW_PATH: process.env.LOOM_FLOW_PATH,
    LOOM_FLOW_NAME: flow.name,
    LOOM_FLOW_CWD: process.env.LOOM_FLOW_CWD ?? process.cwd(),
    LOOM_AGENT: args.name,
    LOOM_AGENT_TYPE: configuredAgent.type,
    LOOM_RUN_ID: RUN_ID,
    LOOM_SERVER_ORIGIN: SERVER_ORIGIN,
    LOOM_PARENT_AGENT: args.name,
    LOOM_PARENT_DEPTH: String(args.parentDepth + 1),
    LOOM_SUBAGENT_BIN: subagentBin,
  });
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

async function mergeMcpConfigFiles(baseConfigPath: string | undefined, loomConfigPath: string): Promise<{ configPath: string; cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-subagent-merged-mcp-"));
  const configPath = path.join(tempDir, "mcp.json");
  const mergedServers: Record<string, unknown> = {};
  if (baseConfigPath) {
    try {
      const parsed = JSON.parse(await readFile(baseConfigPath, "utf8")) as { mcpServers?: Record<string, unknown> };
      Object.assign(mergedServers, parsed.mcpServers ?? {});
    } catch {
      // If the scoped config is unreadable, keep the Loom MCP server available.
    }
  }
  const loomParsed = JSON.parse(await readFile(loomConfigPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  Object.assign(mergedServers, loomParsed.mcpServers ?? {});
  await writeFile(configPath, JSON.stringify({ mcpServers: mergedServers }, null, 2), "utf8");
  return {
    configPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function buildClaudePrompt(args: CliArgs, reportPath: string, delegation: string): string {
  return `You are the "${args.name}" subagent in a Loom flow. A single BRIEFING follows. Execute it autonomously using as many tool calls as needed. Do not ask follow-up questions back to the caller.

When finished, write the REPORT to ${reportPath} in this exact format:

\`\`\`
status: done | blocked | needs_decision
summary:
  - <bullet — concrete fact, file:line backed>
artifacts:
  - <path>:<line-range>
blockers:
  - <one sentence — omit when status=done>
\`\`\`

Write the REPORT file before exiting.
${delegation}
BRIEFING:
${args.briefing}
`;
}

function buildCodexPrompt(args: CliArgs, reportPath: string, delegation: string): string {
  return `You are the "${args.name}" subagent in a Loom flow. A single BRIEFING follows. Execute it autonomously, using as many tool calls as needed. Do not ask follow-up questions back to the caller.

When finished, write the REPORT to ${reportPath} in this exact format:

\`\`\`
status: done | blocked | needs_decision
summary:
  - <bullet — concrete fact, file:line backed>
  - review: pass
artifacts:
  - <path>:<line-range>
blockers:
  - <one sentence — omit when status=done>
\`\`\`

Write the REPORT file before exiting. If you hit the wall clock, still write a best-effort REPORT with status=blocked.
${delegation}
BRIEFING:
${args.briefing}
`;
}

async function runBackend(args: CliArgs, reportPath: string): Promise<number> {
  // Resolve flow context + scoped resources so the spawned child gets its
  // own HOME with only the mcps / hooks / skills this agent is allowed to
  // use. Missing flow context (e.g. standalone test invocation) falls back
  // to an empty resource set and inherits the parent HOME.
  const ctx = await loadFlowContext(args.name);
  let delegation = "";
  let isolatedHome: string | undefined;
  let scopedMcpConfigPath: string | undefined;
  let effectiveMcpConfigPath: string | undefined;
  const cleanup: Array<() => Promise<void>> = [];

  if (ctx) {
    const [hookDefs, skillDefs] = await Promise.all([loadHookDefinitions(), loadSkillDefinitions()]);
    const resources = resolveAgentResources(ctx.selfAgent, ctx.flow);
    const scopedHooks = resources.hooks
      .map((name) => hookDefs.get(name))
      .filter((hook): hook is HookDefinition => Boolean(hook));
    const scopedSkills = resources.skills
      .map((name) => skillDefs.get(name))
      .filter((skill): skill is SkillDefinition => Boolean(skill));
    const configuredAgent = buildConfiguredAgent(ctx.selfAgent, ctx.flow, ctx.flow.repo, {
      roles: new Map(),
      hooks: new Map(scopedHooks.map((h) => [h.name, h])),
      skills: new Map(scopedSkills.map((s) => [s.name, s])),
    });
    delegation = buildDelegationPrompt(ctx.selfAgent, args.name);
    const loomMcpConfig = delegation.trim()
      ? await createLoomMcpConfig(args, ctx.flow, configuredAgent)
      : undefined;
    if (loomMcpConfig) {
      cleanup.push(loomMcpConfig.cleanup);
    }
    isolatedHome = await createSubagentHome(args, ctx.flow, configuredAgent, scopedHooks, scopedSkills, loomMcpConfig?.codexConfigToml);
    cleanup.push(async () => { await rm(isolatedHome!, { recursive: true, force: true }).catch(() => undefined); });
    // Read MCP server definitions from the REAL user home — the fresh
    // isolated HOME has empty mcpServers, so passing it as homeDir would
    // yield an empty config (exactly the bug we just saw).
    scopedMcpConfigPath = await createScopedMcpConfig(ctx.selfAgent, ctx.flow);
    if (scopedMcpConfigPath) {
      cleanup.push(async () => {
        await rm(path.dirname(scopedMcpConfigPath!), { recursive: true, force: true }).catch(() => undefined);
      });
    }
    if (loomMcpConfig) {
      const merged = await mergeMcpConfigFiles(scopedMcpConfigPath, loomMcpConfig.claudeConfigPath);
      effectiveMcpConfigPath = merged.configPath;
      cleanup.push(merged.cleanup);
    } else {
      effectiveMcpConfigPath = scopedMcpConfigPath;
    }
  }

  const childEnv: Record<string, string> = {
    ...process.env,
    LOOM_REPORT_FILE: reportPath,
    LOOM_PARENT_AGENT: args.name,
    LOOM_PARENT_DEPTH: String(args.parentDepth + 1),
    LOOM_SUBAGENT_BIN: fileURLToPath(new URL("./subagent-launcher.js", import.meta.url)),
  };
  if (isolatedHome) {
    childEnv.HOME = isolatedHome;
    childEnv.USERPROFILE = isolatedHome;
    childEnv.XDG_CONFIG_HOME = path.join(isolatedHome, ".config");
    childEnv.CODEX_HOME = path.join(isolatedHome, ".codex");
    childEnv.CODEX_CONFIG_DIR = path.join(isolatedHome, ".codex");
  }
  if (effectiveMcpConfigPath) {
    childEnv.LOOM_MCP_CONFIG_PATH = effectiveMcpConfigPath;
  }

  let command: string;
  let childArgs: string[];
  let parseLine: (line: string) => MappedEvent[];

  if (args.backend === "codex") {
    const model = args.model ?? "gpt-5.5";
    const prompt = buildCodexPrompt(args, reportPath, delegation);
    command = "codex";
    childArgs = [
      "exec",
      "--json",
      "--model", model,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      prompt,
    ];
    parseLine = (line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type !== "item.completed") return [];
        const item = parsed.item;
        if (!item || typeof item !== "object") return [];
        const mapped = mapCodexItem(item as Record<string, unknown>);
        return mapped ? [mapped] : [];
      } catch {
        return [];
      }
    };
  } else {
    const model = args.model;
    const prompt = buildClaudePrompt(args, reportPath, delegation);
    const sessionId = randomUUID();
    command = "claude";
    childArgs = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--session-id", sessionId,
      "--no-session-persistence",
      "--dangerously-skip-permissions",
    ];
    if (effectiveMcpConfigPath) {
      childArgs.push("--strict-mcp-config", "--mcp-config", effectiveMcpConfigPath);
    } else {
      childArgs.push("--strict-mcp-config");
    }
    if (model) childArgs.push("--model", model);
    childArgs.push(prompt);
    parseLine = (line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return mapClaudeFrame(parsed);
      } catch {
        return [];
      }
    };
  }

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(command, childArgs, {
      stdio: ["ignore", "pipe", "inherit"],
      env: childEnv,
    });

    let buffer = "";
    let reportSnapshot = "";
    let reportSeenAt = 0;
    let reportDrivenExit = false;
    let reportShutdownStarted = false;
    let childExited = false;
    let reportShutdownKiller: ReturnType<typeof setTimeout> | undefined;

    const flushLines = (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          for (const mapped of parseLine(line)) {
            postEvent(args, mapped.type, mapped.summary, { toolName: mapped.toolName }).catch(() => undefined);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };

    const cleanupTimers = () => {
      clearTimeout(killer);
      clearInterval(reportWatcher);
      if (reportShutdownKiller) clearTimeout(reportShutdownKiller);
    };

    const checkReport = async () => {
      if (reportShutdownStarted) return;
      let report: string;
      try {
        report = await readFile(reportPath, "utf8");
      } catch {
        return;
      }
      if (!isCompleteReport(report, args)) {
        reportSnapshot = "";
        reportSeenAt = 0;
        return;
      }

      if (report !== reportSnapshot) {
        reportSnapshot = report;
        reportSeenAt = Date.now();
        return;
      }

      if (Date.now() - reportSeenAt < REPORT_STABLE_MS) return;
      reportDrivenExit = true;
      reportShutdownStarted = true;
      child.kill("SIGTERM");
      reportShutdownKiller = setTimeout(() => {
        if (!childExited) child.kill("SIGKILL");
      }, REPORT_SHUTDOWN_GRACE_MS);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => flushLines(chunk));

    const killer = setTimeout(() => {
      child.kill("SIGTERM");
    }, args.maxSeconds * 1000);
    const reportWatcher = setInterval(() => {
      void checkReport();
    }, REPORT_POLL_MS);
    void checkReport();

    child.once("exit", (code) => {
      childExited = true;
      cleanupTimers();
      if (buffer.trim()) {
        for (const mapped of parseLine(buffer.trim())) {
          postEvent(args, mapped.type, mapped.summary, { toolName: mapped.toolName }).catch(() => undefined);
        }
        buffer = "";
      }
      resolve(reportDrivenExit || isCompleteReport(reportSnapshot, args) ? 0 : (code ?? 1));
    });
    child.once("error", () => {
      cleanupTimers();
      resolve(reportDrivenExit ? 0 : 1);
    });
  });

  for (const fn of cleanup) {
    await fn();
  }
  return exitCode;
}

async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv.slice(2));
  if (!parsedArgs) process.exit(2);
  const args: CliArgs = parsedArgs;
  args.briefing = await readBriefing(args.briefing, args.briefingFile);
  if (!args.briefing) {
    console.error("loom-subagent: empty BRIEFING. Pass a non-empty task with --briefing, --briefing-file, a final positional argument after --, or a stdin pipe.");
    process.exit(2);
  }

  const reportPath = args.reportPath
    ?? path.join(DEFAULT_REPORT_DIR, `report-${args.name}-${process.pid}-${Date.now()}.txt`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, initialReport(args.name), "utf8");

  const briefingPreview = args.briefing
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
  await postEvent(
    args,
    "tool_use",
    `${args.name} spawned (${args.backend}${args.model ? ` ${args.model}` : ""}) — ${briefingPreview.slice(0, 140)}`,
    { toolName: "loom-subagent" },
  );

  const exitCode = await runBackend(args, reportPath);

  let report = "";
  try {
    report = await readFile(reportPath, "utf8");
  } catch {
    report = "status: blocked\nsummary:\n  - report file missing\n";
  }

  // Hard cap REPORT size to protect the leader's Opus context. The yaml
  // `conductor-rules` asks for ≤400 tokens but that's LLM-self-compliance;
  // this is the enforcement layer. If the subagent went over, we save the
  // full text as an artifact file and replace the REPORT with a truncated
  // version + a pointer to the artifact.
  const MAX_REPORT_CHARS = 1800; // ≈ 400 tokens of ascii; generous for korean mixed
  if (report.length > MAX_REPORT_CHARS) {
    const artifactPath = reportPath.replace(/\.txt$/, ".full.txt");
    try {
      await writeFile(artifactPath, report, "utf8");
    } catch {
      // best effort — worst case the full REPORT is in reportPath still
    }
    const head = report.slice(0, MAX_REPORT_CHARS);
    report = `${head}\n\n--- [loom-subagent] REPORT truncated at ${MAX_REPORT_CHARS} chars. full text: ${artifactPath} ---\n`;
  }

  const firstLine = report.split("\n").find((line) => line.trim().length > 0) ?? "";
  await postEvent(
    args,
    exitCode === 0 ? "tool_result" : "error",
    `${args.name} ${exitCode === 0 ? "done" : `exit ${exitCode}`} — ${firstLine.slice(0, 140)}`,
    { toolName: "loom-subagent" },
  );

  process.stdout.write(report);
  process.stdout.write(report.endsWith("\n") ? "" : "\n");
  process.exit(exitCode === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("loom-subagent: fatal", error);
  process.exit(1);
});
