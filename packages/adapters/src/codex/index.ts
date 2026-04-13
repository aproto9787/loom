import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "@loom/core";
import { emitMockEvents, parseDelegationDirective, parseParallelDelegationDirective } from "../protocol.js";
import type { AgentAdapter, AgentEvent, SpawnController } from "../types.js";

export const codexAdapterId = "codex";

function buildPrompt(config: AgentConfig, input: string): string {
  if (!config.system) {
    return input;
  }

  return [
    "[System instructions]",
    config.system,
    "",
    "[User request]",
    input,
  ].join("\n");
}

function buildArgs(config: AgentConfig, outputPath: string, cwd: string): string[] {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ephemeral",
    "-C",
    cwd,
    "-o",
    outputPath,
  ];

  if (config.model) {
    args.push("-m", config.model);
  }

  args.push("-");
  return args;
}

function extractSessionId(value: unknown): string | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);

    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      if (/session.?id/i.test(key) && typeof entry === "string" && entry.length > 0) {
        return entry;
      }
      if (entry && typeof entry === "object") {
        stack.push(entry);
      }
    }
  }

  return undefined;
}

function extractCodexText(payload: unknown): string[] {
  const segments: string[] = [];

  function visit(value: unknown): void {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if (typeof record.delta === "string" && record.delta.length > 0) {
      segments.push(record.delta);
    }

    if (typeof record.text === "string" && record.text.length > 0 && /message|output|delta/i.test(type)) {
      segments.push(record.text);
    }

    if (typeof record.content === "string" && record.content.length > 0 && /message|output|delta/i.test(type)) {
      segments.push(record.content);
    }

    for (const key of ["message", "content", "delta", "item", "part", "response"]) {
      if (record[key]) {
        visit(record[key]);
      }
    }
  }

  visit(payload);
  return segments;
}

class CodexAdapter implements AgentAdapter {
  readonly type = "codex" as const;

  async *spawn(
    config: AgentConfig,
    input: string,
    cwd: string,
    controller?: SpawnController,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    if (process.env.LOOM_MOCK === "1") {
      yield* emitMockEvents(`Mock Codex response from ${config.name}: ${input}`);
      return;
    }

    let tempDir: string | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-codex-"));
      const outputPath = path.join(tempDir, "last-message.txt");
      const proc = spawn("codex", buildArgs(config, outputPath, cwd), {
        cwd,
        env: {
          ...process.env,
          ...(controller?.isolatedHome ? { HOME: controller.isolatedHome } : {}),
          ...(controller?.env ?? {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        signal: controller?.signal,
      });

      if (!proc.stdin || !proc.stdout || !proc.stderr) {
        throw new Error("codex CLI spawn did not provide stdio pipes");
      }

      if (controller?.signal) {
        controller.signal.addEventListener("abort", () => {
          proc.kill("SIGTERM");
          controller.onAbort?.();
        }, { once: true });
      }

      if (controller?.timeoutMs) {
        timeoutHandle = setTimeout(() => {
          proc.kill("SIGTERM");
          controller.onTimeout?.();
        }, controller.timeoutMs);
      }

      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");

      let stderr = "";
      let sessionId: string | undefined;
      proc.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      proc.stdin.end(buildPrompt(config, input));

      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line.length === 0) {
            continue;
          }

          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const discoveredSessionId = extractSessionId(parsed);
            if (discoveredSessionId) {
              sessionId = discoveredSessionId;
            }

            if (/error/i.test(typeof parsed.type === "string" ? parsed.type : "")) {
              const message = typeof parsed.message === "string"
                ? parsed.message
                : stderr.trim() || "codex CLI returned an error";
              throw new Error(message);
            }

            for (const segment of extractCodexText(parsed)) {
              if (segment.length > 0) {
                yield { type: "token", content: segment };
              }
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              yield { type: "token", content: line };
              continue;
            }
            throw error;
          }
        }
      }

      if (buffer.trim().length > 0) {
        try {
          const parsed = JSON.parse(buffer.trim()) as Record<string, unknown>;
          const discoveredSessionId = extractSessionId(parsed);
          if (discoveredSessionId) {
            sessionId = discoveredSessionId;
          }
          for (const segment of extractCodexText(parsed)) {
            if (segment.length > 0) {
              yield { type: "token", content: segment };
            }
          }
        } catch {
          yield { type: "token", content: buffer };
        }
      }

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.once("error", reject);
        proc.once("close", resolve);
      });

      if (exitCode !== 0) {
        const sessionHint = sessionId ? ` (session ${sessionId})` : "";
        throw new Error(stderr.trim() || `codex CLI exited with code ${exitCode}${sessionHint}`);
      }

      const output = (await readFile(outputPath, "utf8").catch(() => "")).trimEnd();
      const parallelDelegation = parseParallelDelegationDirective(output);
      if (parallelDelegation) {
        for (const delegation of parallelDelegation) {
          yield { type: "delegate", ...delegation };
        }
        return;
      }

      const delegation = parseDelegationDirective(output);
      if (delegation) {
        yield { type: "delegate", ...delegation };
        return;
      }

      yield { type: "complete", output };
    } catch (error) {
      yield {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

export const codexAdapter = new CodexAdapter();
