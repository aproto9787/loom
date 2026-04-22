import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const activeLocalCliRuns = new Map<string, ChildProcess>();

export interface LocalCliRunInput {
  runId: string;
  flowPath: string;
  userPrompt: string;
  workspaceRoot: string;
  serverOrigin: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (exitCode: number) => void;
}

export function startLocalCliRun(input: LocalCliRunInput): { runId: string; child: ChildProcess } {
  const cliEntry = path.join(input.workspaceRoot, "packages", "cli", "dist", "index.js");
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      "--flow", input.flowPath,
      "--prompt", input.userPrompt,
      "--run-id", input.runId,
      "--server", input.serverOrigin,
      "--headless",
    ],
    {
      cwd: input.workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LOOM_RUN_ID: input.runId,
        LOOM_SERVER_ORIGIN: input.serverOrigin,
      },
    },
  );

  activeLocalCliRuns.set(input.runId, child);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => input.onStdout?.(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => input.onStderr?.(chunk));

  child.once("exit", (code, signal) => {
    activeLocalCliRuns.delete(input.runId);
    input.onExit?.(signal ? 1 : (code ?? 0));
  });
  child.once("error", () => {
    activeLocalCliRuns.delete(input.runId);
    input.onExit?.(1);
  });

  return { runId: input.runId, child };
}

export function abortLocalCliRun(runId: string): boolean {
  const child = activeLocalCliRuns.get(runId);
  if (!child) return false;
  child.kill("SIGTERM");
  activeLocalCliRuns.delete(runId);
  return true;
}
