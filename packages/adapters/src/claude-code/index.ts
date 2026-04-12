import { spawn } from "node:child_process";
import path from "node:path";
import type { InvokeContext, InvokeEvent, RuntimeAdapter } from "@loom/core";

export const claudeCodeAdapterId = "claude-code";

const DEFAULT_PROMPT = "Continue.";

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

function buildArgs(ctx: InvokeContext): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
  ];

  if (typeof ctx.node.config.model === "string" && ctx.node.config.model.length > 0) {
    args.push("--model", ctx.node.config.model);
  }

  if (typeof ctx.node.config.system === "string" && ctx.node.config.system.length > 0) {
    args.push("--system-prompt", ctx.node.config.system);
  }

  return args;
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

function extractClaudeText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const segments: string[] = [];
  const contentCandidates = [
    record.message,
    record.partial_message,
    record.content,
    record.delta,
  ];

  for (const candidate of contentCandidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const content = Array.isArray((candidate as { content?: unknown }).content)
      ? (candidate as { content: Array<Record<string, unknown>> }).content
      : Array.isArray(candidate)
        ? candidate as Array<Record<string, unknown>>
        : [];

    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        segments.push(block.text);
      }
    }
  }

  return segments.join("");
}

function extractClaudeDelta(candidate: string, emittedText: string): string {
  if (candidate.length === 0) {
    return "";
  }

  if (candidate.startsWith(emittedText)) {
    return candidate.slice(emittedText.length);
  }

  if (emittedText.endsWith(candidate)) {
    return "";
  }

  return candidate;
}

class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = claudeCodeAdapterId;

  supports(nodeType: string): boolean {
    return nodeType === "agent.claude-code";
  }

  async *invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    const prompt = getPrompt(ctx);

    if (process.env.LOOM_MOCK === "1") {
      yield* emitMockReply(`Mock Claude Code response about: ${prompt}`);
      return;
    }

    try {
      const proc = spawn("claude", buildArgs(ctx), {
        cwd: getWorkingDirectory(ctx),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (!proc.stdout || !proc.stderr || !proc.stdin) {
        throw new Error("claude CLI spawn did not provide stdio pipes");
      }

      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");

      let stderr = "";
      proc.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      proc.stdin.end(`${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      })}\n`);

      let buffer = "";
      let emittedText = "";
      let finalOutput: string | undefined;

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
            emittedText += line;
            continue;
          }

          if (parsed.type === "error") {
            const message = typeof parsed.error === "string"
              ? parsed.error
              : typeof (parsed.error as { message?: unknown } | undefined)?.message === "string"
                ? (parsed.error as { message: string }).message
                : stderr.trim() || "claude CLI returned an error";
            throw new Error(message);
          }

          const candidate = extractClaudeText(parsed);
          const delta = extractClaudeDelta(candidate, emittedText);
          if (delta.length > 0) {
            emittedText += delta;
            yield { kind: "token", text: delta };
          }

          if (typeof parsed.result === "string" && parsed.result.length > 0) {
            finalOutput = parsed.result;
          }
        }
      }

      if (buffer.trim().length > 0) {
        try {
          const parsed = JSON.parse(buffer.trim()) as Record<string, unknown>;
          if (typeof parsed.result === "string" && parsed.result.length > 0) {
            finalOutput = parsed.result;
          } else {
            const candidate = extractClaudeText(parsed);
            const delta = extractClaudeDelta(candidate, emittedText);
            if (delta.length > 0) {
              emittedText += delta;
              yield { kind: "token", text: delta };
            }
          }
        } catch {
          emittedText += buffer;
          yield { kind: "token", text: buffer };
        }
      }

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.once("error", reject);
        proc.once("close", resolve);
      });

      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `claude CLI exited with code ${exitCode}`);
      }

      yield { kind: "final", output: finalOutput ?? emittedText.trim() };
    } catch (error) {
      yield {
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
