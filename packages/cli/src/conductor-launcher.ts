#!/usr/bin/env node

// loom-conductor: headless executor that orchestrator spawns via Bash.
// Receives a BRIEFING, runs `codex exec` with it, and writes a REPORT file.
// Keeps the calling orchestrator's context clean by returning only the REPORT.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const MODEL = process.env.LOOM_CONDUCTOR_MODEL ?? "gpt-5.4";
const MAX_SECONDS = Number(process.env.LOOM_CONDUCTOR_MAX_SECONDS ?? "900");
const DEFAULT_REPORT_DIR = path.join(os.tmpdir(), "loom-conductor");

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
      "--model", MODEL,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      prompt,
    ], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        LOOM_CONDUCTOR_REPORT_FILE: reportPath,
      },
    });
    const killer = setTimeout(() => {
      child.kill("SIGTERM");
    }, MAX_SECONDS * 1000);
    child.once("exit", (code) => {
      clearTimeout(killer);
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

  const prompt = buildConductorPrompt(briefing, reportPath);
  const exitCode = await runCodex(prompt, reportPath);

  let report = "";
  try {
    report = await readFile(reportPath, "utf8");
  } catch {
    report = "status: blocked\nsummary:\n  - report file missing\n";
  }
  process.stdout.write(report);
  process.stdout.write(report.endsWith("\n") ? "" : "\n");
  process.exit(exitCode === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("loom-conductor: fatal", error);
  process.exit(1);
});
