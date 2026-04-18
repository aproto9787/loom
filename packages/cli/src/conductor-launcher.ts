#!/usr/bin/env node

// loom-conductor: headless codex executor. Retained for backward compat
// with older flow prompts. New flows use `loom-subagent --backend codex`
// (packages/cli/src/subagent-launcher.ts) which supersedes this and adds
// recursive delegation. Prefer the new launcher for anything new.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const MODEL = process.env.LOOM_CONDUCTOR_MODEL ?? "gpt-5.4";
const MAX_SECONDS = Number(process.env.LOOM_CONDUCTOR_MAX_SECONDS ?? "900");
const DEFAULT_REPORT_DIR = path.join(os.tmpdir(), "loom-conductor");
const RUN_ID = process.env.LOOM_RUN_ID;
const SERVER_ORIGIN = process.env.LOOM_SERVER_ORIGIN ?? "http://localhost:8787";
const PARENT_AGENT = process.env.LOOM_PARENT_AGENT ?? "leader";
const PARENT_DEPTH = Number(process.env.LOOM_PARENT_DEPTH ?? "0");

type LoomEventType = "tool_use" | "tool_result" | "user" | "assistant" | "error";

async function postProgress(
  type: LoomEventType,
  summary: string,
  extra: { toolName?: string; agentDepth?: number } = {},
): Promise<void> {
  if (!RUN_ID) return;
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
          agentName: "conductor",
          agentDepth: extra.agentDepth ?? PARENT_DEPTH + 1,
          parentAgent: PARENT_AGENT,
          agentKind: "codex",
        }],
      }),
    });
  } catch {
    // best effort
  }
}

function truncate(value: string, max = 140): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function mapCodexItem(item: Record<string, unknown>): { type: LoomEventType; summary: string; toolName?: string } | null {
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

function printUsage(): void {
  console.error(`loom-conductor — headless executor for the Loom flow conductor role

Usage:
  loom-conductor "<BRIEFING>"
  echo "<BRIEFING>" | loom-conductor

Environment:
  LOOM_CONDUCTOR_MODEL         model to pass to codex exec  (default: gpt-5.4)
  LOOM_CONDUCTOR_MAX_SECONDS   hard timeout                  (default: 900)
  LOOM_CONDUCTOR_REPORT_FILE   explicit report path
`);
}

async function readBriefing(): Promise<string> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  const fromArgs = argv.join(" ").trim();
  if (fromArgs) return fromArgs;
  if (process.stdin.isTTY) {
    printUsage();
    process.exit(2);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function buildConductorPrompt(briefing: string, reportPath: string): string {
  return `You are the Loom flow conductor. A single BRIEFING follows. Execute it autonomously, using as many tool calls as needed. Do not ask follow-up questions back to the caller.

When finished, write the REPORT to ${reportPath} in this exact format:

\`\`\`
status: done | blocked | needs_decision
summary:
  - <bullet — concrete fact, file:line backed>
  - <bullet — concrete fact, file:line backed>
  - review: pass        # include this line only for code-change tasks
artifacts:
  - <path>:<line-range>
blockers:               # omit when status=done and no review fail
  - <one sentence>
\`\`\`

Write the REPORT file before exiting. If you hit the wall clock, still write a best-effort REPORT with status=blocked and a blockers bullet.

BRIEFING:
${briefing}
`;
}

async function runCodex(prompt: string, reportPath: string): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn("codex", [
      "exec",
      "--json",
      "--model", MODEL,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      prompt,
    ], {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        LOOM_CONDUCTOR_REPORT_FILE: reportPath,
      },
    });

    let buffer = "";
    const flushLines = (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          handleLine(line).catch(() => undefined);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };

    const handleLine = async (line: string) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const frameType = typeof parsed.type === "string" ? parsed.type : undefined;
        if (frameType !== "item.completed") return;
        const item = parsed.item;
        if (!item || typeof item !== "object") return;
        const mapped = mapCodexItem(item as Record<string, unknown>);
        if (!mapped) return;
        await postProgress(mapped.type, mapped.summary, { toolName: mapped.toolName, agentDepth: PARENT_DEPTH + 1 });
      } catch {
        // ignore non-JSON frames
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => flushLines(chunk));

    const killer = setTimeout(() => {
      child.kill("SIGTERM");
    }, MAX_SECONDS * 1000);
    child.once("exit", (code) => {
      clearTimeout(killer);
      if (buffer.trim()) {
        handleLine(buffer.trim()).catch(() => undefined);
        buffer = "";
      }
      resolve(code ?? 1);
    });
    child.once("error", () => {
      clearTimeout(killer);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  const briefing = await readBriefing();
  if (!briefing) {
    console.error("loom-conductor: empty BRIEFING");
    process.exit(2);
  }
  const reportPath = process.env.LOOM_CONDUCTOR_REPORT_FILE
    ?? path.join(DEFAULT_REPORT_DIR, `report-${process.pid}-${Date.now()}.txt`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, "status: blocked\nsummary:\n  - conductor did not start\n", "utf8");

  const briefingPreview = briefing.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" | ");
  await postProgress("tool_use", `conductor spawned (${MODEL}) — ${briefingPreview.slice(0, 140)}`, { toolName: "loom-conductor" });

  const prompt = buildConductorPrompt(briefing, reportPath);
  const exitCode = await runCodex(prompt, reportPath);

  let report = "";
  try {
    report = await readFile(reportPath, "utf8");
  } catch {
    report = "status: blocked\nsummary:\n  - report file missing\n";
  }

  const firstLine = report.split("\n").find((line) => line.trim().length > 0) ?? "";
  await postProgress(
    exitCode === 0 ? "tool_result" : "error",
    `conductor ${exitCode === 0 ? "done" : `exit ${exitCode}`} — ${firstLine.slice(0, 140)}`,
    { toolName: "loom-conductor" },
  );

  process.stdout.write(report);
  process.stdout.write(report.endsWith("\n") ? "" : "\n");
  process.exit(exitCode === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("loom-conductor: fatal", error);
  process.exit(1);
});
