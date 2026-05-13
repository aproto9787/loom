#!/usr/bin/env node

// heddle-subagent: generalized headless executor. Heddle MCP invokes this internal
// runtime to execute a BRIEFING in an isolated child agent. The child runs
// Codex, streams every tool_use / tool_result / assistant frame back to the
// server tagged with this subagent's name and parent, and writes a REPORT to
// stdout / file.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import * as HeddleCore from "@aproto9787/heddle-core";
import type { AgentConfig, FlowDefinition } from "@aproto9787/heddle-core";
import {
  buildConfiguredAgent,
  findAgentByName,
} from "@aproto9787/heddle-runtime";
import { buildDelegationPrompt } from "./delegation-prompt.js";

type Backend = "codex";
type HeddleEventType = "tool_use" | "tool_result" | "user" | "assistant" | "error";

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

const RUN_ID = process.env.HEDDLE_RUN_ID;
const SERVER_ORIGIN = process.env.HEDDLE_SERVER_ORIGIN ?? "http://localhost:8787";
const DEFAULT_REPORT_DIR = path.join(os.tmpdir(), "heddle-subagent");
const REPORT_POLL_MS = 500;
const REPORT_STABLE_MS = 1000;
const REPORT_SHUTDOWN_GRACE_MS = 3000;

function printUsage(): void {
  console.error(`heddle-subagent — generalized child-agent runner for Heddle flows

Usage:
  heddle-subagent --name <role> --backend codex [options] --briefing "Review the changed files"
  heddle-subagent --name <role> --backend codex [options] -- "Briefing that may start with --"
  printf '%s\n' "Review the changed files" | heddle-subagent --name <role> --backend codex [options]

Options:
  --name <role>          child agent display name (required)
  --backend <kind>       codex (required). Legacy "claude" is migrated to codex.
  --model <id>           model override (default: backend default)
  --parent <name>        parent agent name (default: env HEDDLE_PARENT_AGENT or "leader")
  --depth <n>            parent depth (default: env HEDDLE_PARENT_DEPTH or 0)
  --max-seconds <n>      hard timeout (default: 900)
  --report <path>        explicit REPORT file path
  --briefing <text>      explicit task briefing; safest for one-line delegated tasks
  --briefing-file <path> read task briefing from a file; useful for long/multiline tasks

Environment:
  HEDDLE_RUN_ID            run id to POST events to (required to stream)
  HEDDLE_SERVER_ORIGIN     server origin (default: http://localhost:8787)
  HEDDLE_PARENT_AGENT      fallback parent name
  HEDDLE_PARENT_DEPTH      fallback parent depth
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
          console.error(`heddle-subagent: unknown option --${key}`);
          printUsage();
          return null;
        }
        args[key] = cur.slice(equalIndex + 1);
        continue;
      }

      const key = cur.slice(2);
      if (!optionsWithValues.has(key)) {
        console.error(`heddle-subagent: unknown option --${key}`);
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
  if (backendRaw === "claude") {
    console.error("heddle-subagent: legacy --backend claude was migrated to codex");
  }

  const explicitBriefing = args.briefing?.trim();
  return {
    name,
    backend: "codex",
    model: args.model,
    parentAgent: args.parent ?? process.env.HEDDLE_PARENT_AGENT ?? "leader",
    parentDepth: Number(args.depth ?? process.env.HEDDLE_PARENT_DEPTH ?? "0"),
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
  type: HeddleEventType,
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
  type: HeddleEventType;
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

interface FlowContext {
  flow: FlowDefinition;
  selfAgent: AgentConfig;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasLegacyAgentType(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as { type?: unknown }).type === "claude-code") return true;
  if (Array.isArray(value)) return value.some((entry) => hasLegacyAgentType(entry));
  return Object.values(value as Record<string, unknown>).some((entry) => hasLegacyAgentType(entry));
}

function migrateAgentRecord(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const agent = { ...(value as Record<string, unknown>) };
  if (agent.type === "claude-code") {
    agent.type = "codex";
  }
  if (agent.type === "codex") {
    const runtime = agent.runtime && typeof agent.runtime === "object"
      ? { ...(agent.runtime as Record<string, unknown>) }
      : {};
    if (runtime.profile === undefined || runtime.profile === "claude-default") {
      runtime.profile = "codex-default";
    }
    if (runtime.mode === undefined) runtime.mode = "host";
    if (runtime.applyResources === undefined) runtime.applyResources = "prompt-only";
    if (runtime.delegationTransport === undefined) runtime.delegationTransport = "mcp";
    agent.runtime = runtime;
    if (agent.model === undefined || (typeof agent.model === "string" && agent.model.startsWith("claude-"))) {
      agent.model = "gpt-5.5";
    }
  }
  if (Array.isArray(agent.agents)) {
    agent.agents = agent.agents.map((child) => migrateAgentRecord(child));
  }
  return agent;
}

function migrateLegacyFlowDefinitionInput(value: unknown): { value: unknown; notes: string[] } {
  if (!hasLegacyAgentType(value)) return { value, notes: [] };
  const helper = (HeddleCore as Record<string, unknown>).migrateLegacyFlowDefinitionInput;
  if (typeof helper === "function") {
    try {
      const migrated = helper(cloneJson(value)) as { value?: unknown; notes?: unknown };
      const notes = Array.isArray(migrated.notes)
        ? migrated.notes
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
          .filter((entry) => entry.trim().length > 0)
        : [];
      return {
        value: migrated.value ?? migrated,
        notes: notes.length > 0 ? notes : ["core legacy migration helper applied"],
      };
    } catch {
      // Fall through to the local compatibility migration.
    }
  }
  const flow = { ...(value as Record<string, unknown>) };
  if (flow.orchestrator) {
    flow.orchestrator = migrateAgentRecord(flow.orchestrator);
  }
  return { value: flow, notes: ["core legacy migration helper unavailable; applied built-in Codex migration"] };
}

async function loadFlowContext(selfName: string): Promise<FlowContext | undefined> {
  const flowPath = process.env.HEDDLE_FLOW_PATH;
  if (!flowPath) return undefined;
  try {
    const raw = await readFile(flowPath, "utf8");
    const parsed = migrateLegacyFlowDefinitionInput(YAML.parse(raw)).value as FlowDefinition | undefined;
    if (!parsed?.orchestrator) return undefined;
    const found = findAgentByName(parsed.orchestrator, selfName);
    if (!found) return undefined;
    return { flow: parsed, selfAgent: found };
  } catch {
    return undefined;
  }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function mergeInstructions(flowFlowMd: string | undefined, agentFlowMd: string | undefined, system: string | undefined): string {
  return [flowFlowMd?.trim(), agentFlowMd?.trim(), system?.trim()].filter(Boolean).join("\n\n");
}

async function createSubagentHome(
  args: CliArgs,
  flow: FlowDefinition,
  configuredAgent: AgentConfig,
  codexConfigAppend?: string,
): Promise<string> {
  const root = path.join(os.homedir(), ".heddle", "subagent-homes");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, `${args.name}-`));
  const realHome = os.homedir();
  const agentFlowMd = configuredAgent.flowMdRef
    ? flow.flowMdLibrary?.[configuredAgent.flowMdRef]
    : undefined;
  const merged = mergeInstructions(flow.flowMd, agentFlowMd, configuredAgent.system);

  const codexDir = path.join(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const realAuth = await readOptional(path.join(realHome, ".codex", "auth.json"));
  if (realAuth) {
    await writeFile(path.join(codexDir, "auth.json"), realAuth, { encoding: "utf8", mode: 0o600 });
  }
  const realConfig = await readOptional(path.join(realHome, ".codex", "config.toml"));
  const configParts = [realConfig ?? "# Heddle-seeded (empty)\n"];
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
  return home;
}

interface HeddleMcpConfig {
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
    "[mcp_servers.heddle]",
    `command = ${quoteTomlString(command)}`,
    `args = [${argsArray}]`,
    `env = { ${envEntries} }`,
  ].join("\n");
}

function compactEnv(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function createHeddleMcpConfig(args: CliArgs, flow: FlowDefinition, configuredAgent: AgentConfig): Promise<HeddleMcpConfig> {
  const cliBin = fileURLToPath(new URL("./index.js", import.meta.url));
  const subagentBin = fileURLToPath(new URL("./subagent-launcher.js", import.meta.url));
  const env = compactEnv({
    HEDDLE_FLOW_PATH: process.env.HEDDLE_FLOW_PATH,
    HEDDLE_FLOW_NAME: flow.name,
    HEDDLE_FLOW_CWD: process.env.HEDDLE_FLOW_CWD ?? process.cwd(),
    HEDDLE_AGENT: args.name,
    HEDDLE_AGENT_TYPE: configuredAgent.type,
    HEDDLE_RUN_ID: RUN_ID,
    HEDDLE_SERVER_ORIGIN: SERVER_ORIGIN,
    HEDDLE_PARENT_AGENT: args.name,
    HEDDLE_PARENT_DEPTH: String(args.parentDepth + 1),
    HEDDLE_SUBAGENT_BIN: subagentBin,
  });
  return {
    codexConfigToml: buildCodexMcpConfigToml(env, process.execPath, [cliBin, "mcp"]),
    cleanup: async () => undefined,
  };
}

function buildCodexPrompt(args: CliArgs, reportPath: string, delegation: string): string {
  return `You are the "${args.name}" subagent in a Heddle flow. A single BRIEFING follows. Execute it autonomously, using as many tool calls as needed. Do not ask follow-up questions back to the caller.

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
  const cleanup: Array<() => Promise<void>> = [];

  if (ctx) {
    const configuredAgent = buildConfiguredAgent(ctx.selfAgent, ctx.flow, ctx.flow.repo, {
      roles: new Map(),
      hooks: new Map(),
      skills: new Map(),
    });
    delegation = buildDelegationPrompt(ctx.selfAgent, args.name);
    const heddleMcpConfig = delegation.trim()
      ? await createHeddleMcpConfig(args, ctx.flow, configuredAgent)
      : undefined;
    if (heddleMcpConfig) {
      cleanup.push(heddleMcpConfig.cleanup);
    }
    isolatedHome = await createSubagentHome(args, ctx.flow, configuredAgent, heddleMcpConfig?.codexConfigToml);
    cleanup.push(async () => { await rm(isolatedHome!, { recursive: true, force: true }).catch(() => undefined); });
  }

  const childEnv: Record<string, string> = {
    ...process.env,
    HEDDLE_REPORT_FILE: reportPath,
    HEDDLE_PARENT_AGENT: args.name,
    HEDDLE_PARENT_DEPTH: String(args.parentDepth + 1),
    HEDDLE_SUBAGENT_BIN: fileURLToPath(new URL("./subagent-launcher.js", import.meta.url)),
  };
  if (isolatedHome) {
    childEnv.HOME = isolatedHome;
    childEnv.USERPROFILE = isolatedHome;
    childEnv.XDG_CONFIG_HOME = path.join(isolatedHome, ".config");
    childEnv.CODEX_HOME = path.join(isolatedHome, ".codex");
    childEnv.CODEX_CONFIG_DIR = path.join(isolatedHome, ".codex");
  }
  const model = args.model ?? "gpt-5.5";
  const prompt = buildCodexPrompt(args, reportPath, delegation);
  const command = "codex";
  const childArgs = [
    "exec",
    "--json",
    "--model", model,
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    prompt,
  ];
  const parseLine = (line: string): MappedEvent[] => {
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
    console.error("heddle-subagent: empty BRIEFING. Pass a non-empty task with --briefing, --briefing-file, a final positional argument after --, or a stdin pipe.");
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
    { toolName: "heddle-subagent" },
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
    report = `${head}\n\n--- [heddle-subagent] REPORT truncated at ${MAX_REPORT_CHARS} chars. full text: ${artifactPath} ---\n`;
  }

  const firstLine = report.split("\n").find((line) => line.trim().length > 0) ?? "";
  await postEvent(
    args,
    exitCode === 0 ? "tool_result" : "error",
    `${args.name} ${exitCode === 0 ? "done" : `exit ${exitCode}`} — ${firstLine.slice(0, 140)}`,
    { toolName: "heddle-subagent" },
  );

  process.stdout.write(report);
  process.stdout.write(report.endsWith("\n") ? "" : "\n");
  process.exit(exitCode === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("heddle-subagent: fatal", error);
  process.exit(1);
});
