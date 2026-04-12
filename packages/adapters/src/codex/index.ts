import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { InvokeContext, InvokeEvent, RuntimeAdapter } from "@loom/core";

export const codexAdapterId = "codex";

const DEFAULT_PROMPT = "Continue.";

interface CodexSessionState {
  sessionId?: string;
}

function getPrompt(ctx: InvokeContext): string {
  if (typeof ctx.resolvedInputs.prompt === "string" && ctx.resolvedInputs.prompt.trim().length > 0) {
    return ctx.resolvedInputs.prompt;
  }

  if (typeof ctx.resolvedInputs.topic === "string" && ctx.resolvedInputs.topic.trim().length > 0) {
    return ctx.resolvedInputs.topic;
  }

  const entries = Object.entries(ctx.resolvedInputs);
  if (entries.length === 1 && typeof entries[0]?.[1] === "string" && entries[0][1].trim().length > 0) {
    return entries[0][1];
  }

  if (entries.length > 0) {
    return JSON.stringify(ctx.resolvedInputs, null, 2);
  }

  return DEFAULT_PROMPT;
}

function getWorkingDirectory(ctx: InvokeContext): string {
  const cwd = typeof ctx.node.config.cwd === "string" ? ctx.node.config.cwd : process.cwd();
  return path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd);
}

function emitMockReply(reply: string): InvokeEvent[] {
  const events: InvokeEvent[] = [];
  const words = reply.split(" ");
  for (let index = 0; index < words.length; index += 1) {
    const chunk = index === 0 ? words[index] : ` ${words[index]}`;
    events.push({ kind: "token", text: chunk });
  }
  events.push({ kind: "final", output: reply });
  return events;
}

function getSessionState(ctx: InvokeContext): CodexSessionState {
  if (!ctx.runtime) {
    return {};
  }

  return ctx.runtime.getOrCreateResource(`codex:${ctx.node.id}:session`, () => ({}));
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

function buildArgs(
  ctx: InvokeContext,
  promptTarget: string,
  outputPath: string,
  sessionId: string | undefined,
): string[] {
  const args = sessionId ? ["exec", "resume"] : ["exec"];

  args.push("--json", "--color", "never", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-o", outputPath);

  if (typeof ctx.node.config.model === "string" && ctx.node.config.model.length > 0) {
    args.push("-m", ctx.node.config.model);
  }

  args.push("-C", getWorkingDirectory(ctx));

  if (sessionId) {
    args.push(sessionId);
  }

  args.push(promptTarget);
  return args;
}

class CodexAdapter implements RuntimeAdapter {
  readonly id = codexAdapterId;

  supports(nodeType: string): boolean {
    return nodeType === "agent.codex";
  }

  async *invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    const prompt = getPrompt(ctx);

    if (process.env.LOOM_MOCK === "1") {
      yield* emitMockReply(`Mock Codex response about: ${prompt}`);
      return;
    }

    let tempDir: string | undefined;
    try {
      const sessionState = getSessionState(ctx);
      tempDir = await mkdtemp(path.join(os.tmpdir(), "loom-codex-"));
      const outputPath = path.join(tempDir, "last-message.txt");
      const proc = spawn("codex", buildArgs(ctx, "-", outputPath, sessionState.sessionId), {
        cwd: getWorkingDirectory(ctx),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (!proc.stdout || !proc.stderr || !proc.stdin) {
        throw new Error("codex CLI spawn did not provide stdio pipes");
      }

      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");

      let stderr = "";
      proc.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      proc.stdin.end(prompt);

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

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            yield { kind: "token", text: line };
            continue;
          }

          const discoveredSessionId = extractSessionId(parsed);
          if (discoveredSessionId) {
            sessionState.sessionId = discoveredSessionId;
          }

          if (/error/i.test(typeof parsed.type === "string" ? parsed.type : "")) {
            const message = typeof parsed.message === "string"
              ? parsed.message
              : stderr.trim() || "codex CLI returned an error";
            throw new Error(message);
          }

          for (const segment of extractCodexText(parsed)) {
            if (segment.length > 0) {
              yield { kind: "token", text: segment };
            }
          }
        }
      }

      if (buffer.trim().length > 0) {
        try {
          const parsed = JSON.parse(buffer.trim()) as Record<string, unknown>;
          const discoveredSessionId = extractSessionId(parsed);
          if (discoveredSessionId) {
            sessionState.sessionId = discoveredSessionId;
          }
          for (const segment of extractCodexText(parsed)) {
            if (segment.length > 0) {
              yield { kind: "token", text: segment };
            }
          }
        } catch {
          yield { kind: "token", text: buffer };
        }
      }

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.once("error", reject);
        proc.once("close", resolve);
      });

      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `codex CLI exited with code ${exitCode}`);
      }

      const finalOutput = await readFile(outputPath, "utf8").catch(() => "");
      yield { kind: "final", output: finalOutput.trim().length > 0 ? finalOutput.trimEnd() : "" };
    } catch (error) {
      yield {
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

export const codexAdapter = new CodexAdapter();
