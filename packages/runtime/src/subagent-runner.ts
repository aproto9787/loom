import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@loom/core";

export type SubagentBackend = "claude" | "codex";

export interface ParsedSubagentReport {
  status: "done" | "blocked" | "needs_decision" | "unknown";
  summary: string[];
  artifacts: string[];
  blockers: string[];
  raw: string;
}

export interface RunSubagentTaskOptions {
  agent: AgentConfig;
  parentAgent: string;
  briefing: string;
  flowPath: string;
  cwd: string;
  runId?: string;
  serverOrigin?: string;
  subagentBin: string;
  parentDepth?: number;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export interface RunSubagentTaskResult {
  taskId: string;
  agent: string;
  status: "done" | "blocked" | "needs_decision" | "error" | "cancelled" | "unknown";
  exitCode: number;
  report: ParsedSubagentReport;
  reportPath: string;
  stdout: string;
  stderr: string;
}

export function backendForAgent(agent: AgentConfig): SubagentBackend {
  return agent.type === "codex" ? "codex" : "claude";
}

export function parseSubagentReport(raw: string): ParsedSubagentReport {
  const lines = raw.split(/\r?\n/);
  const summary: string[] = [];
  const artifacts: string[] = [];
  const blockers: string[] = [];
  let status: ParsedSubagentReport["status"] = "unknown";
  let section: "summary" | "artifacts" | "blockers" | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    const statusMatch = /^status:\s*(done|blocked|needs_decision)\s*$/i.exec(trimmed);
    if (statusMatch) {
      status = statusMatch[1] as ParsedSubagentReport["status"];
      section = undefined;
      continue;
    }
    if (/^summary:\s*$/i.test(trimmed)) {
      section = "summary";
      continue;
    }
    if (/^artifacts:\s*$/i.test(trimmed)) {
      section = "artifacts";
      continue;
    }
    if (/^blockers:\s*$/i.test(trimmed)) {
      section = "blockers";
      continue;
    }
    const bullet = /^\s*-\s*(.+?)\s*$/.exec(line)?.[1];
    if (!bullet || !section) {
      continue;
    }
    if (section === "summary") summary.push(bullet);
    if (section === "artifacts") artifacts.push(bullet);
    if (section === "blockers") blockers.push(bullet);
  }

  return { status, summary, artifacts, blockers, raw };
}

export async function runSubagentTask(options: RunSubagentTaskOptions): Promise<RunSubagentTaskResult> {
  const taskId = randomUUID();
  const reportDir = await mkdtemp(path.join(os.tmpdir(), "loom-mcp-subagent-"));
  const reportPath = path.join(reportDir, `${options.agent.name}-${taskId}.txt`);
  await mkdir(reportDir, { recursive: true });

  if (options.signal?.aborted) {
    return {
      taskId,
      agent: options.agent.name,
      status: "cancelled",
      exitCode: 1,
      report: parseSubagentReport(""),
      reportPath,
      stdout: "",
      stderr: "cancelled before subagent launch",
    };
  }

  const args = [
    options.subagentBin,
    "--name", options.agent.name,
    "--backend", backendForAgent(options.agent),
    "--parent", options.parentAgent,
    "--report", reportPath,
    "--briefing", options.briefing,
  ];
  if (options.agent.model) {
    args.push("--model", options.agent.model);
  }
  if (options.timeoutSeconds) {
    args.push("--max-seconds", String(options.timeoutSeconds));
  }

  const env = {
    ...process.env,
    LOOM_FLOW_PATH: options.flowPath,
    LOOM_FLOW_CWD: options.cwd,
    LOOM_AGENT: options.parentAgent,
    LOOM_PARENT_AGENT: options.parentAgent,
    LOOM_PARENT_DEPTH: String(options.parentDepth ?? 0),
    LOOM_SUBAGENT_BIN: options.subagentBin,
    ...(options.runId ? { LOOM_RUN_ID: options.runId } : {}),
    ...(options.serverOrigin ? { LOOM_SERVER_ORIGIN: options.serverOrigin } : {}),
  };

  const { exitCode, stdout, stderr, cancelled } = await new Promise<{ exitCode: number; stdout: string; stderr: string; cancelled: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let exited = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupAbort = () => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abortHandler);
    };
    const abortHandler = () => {
      cancelled = true;
      if (!exited) child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 5000);
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      cleanupAbort();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      exited = true;
      cleanupAbort();
      resolve({ exitCode: signal ? 1 : (code ?? 0), stdout, stderr, cancelled });
    });
  });

  let reportRaw = stdout;
  try {
    reportRaw = await readFile(reportPath, "utf8");
  } catch {
    // stdout is the fallback because loom-subagent writes the final report there.
  }

  const report = parseSubagentReport(reportRaw);
  const status = cancelled
    ? "cancelled"
    : exitCode === 0
    ? report.status
    : report.status === "unknown"
      ? "error"
      : report.status;

  return {
    taskId,
    agent: options.agent.name,
    status,
    exitCode,
    report,
    reportPath,
    stdout,
    stderr,
  };
}
