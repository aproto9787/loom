import { spawn } from "node:child_process";
import type { AgentConfig } from "@aproto9787/heddle-core";
import { emitMockEvents, parseDelegationDirective, parseParallelDelegationDirective } from "../protocol.js";
import type { AgentAdapter, AgentEvent, SpawnController } from "../types.js";

export const claudeCodeAdapterId = "claude-code";

function buildArgs(config: AgentConfig): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--permission-mode",
    "bypassPermissions",
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.system) {
    args.push("--system-prompt", config.system);
  }

  return args;
}

function extractClaudeText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const segments: string[] = [];
  const candidates = [record.message, record.partial_message, record.content, record.delta];

  for (const candidate of candidates) {
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

function extractDelta(candidate: string, emittedText: string): string {
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

class ClaudeCodeAdapter implements AgentAdapter {
  readonly type = "claude-code" as const;

  async *spawn(
    config: AgentConfig,
    input: string,
    cwd: string,
    controller?: SpawnController,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    if (process.env.HEDDLE_MOCK === "1") {
      yield* emitMockEvents(`Mock Claude Code response from ${config.name}: ${input}`);
      return;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const proc = spawn("claude", buildArgs(config), {
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
        throw new Error("claude CLI spawn did not provide stdio pipes");
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
      proc.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      proc.stdin.end(`${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: input }],
        },
      })}\n`);

      let buffer = "";
      let emittedText = "";
      let finalOutput = "";

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
            if (parsed.type === "error") {
              const message = typeof parsed.error === "string"
                ? parsed.error
                : typeof (parsed.error as { message?: unknown } | undefined)?.message === "string"
                  ? (parsed.error as { message: string }).message
                  : stderr.trim() || "claude CLI returned an error";
              throw new Error(message);
            }

            const candidate = extractClaudeText(parsed);
            const delta = extractDelta(candidate, emittedText);
            if (delta.length > 0) {
              emittedText += delta;
              yield { type: "token", content: delta };
            }

            if (typeof parsed.result === "string" && parsed.result.length > 0) {
              finalOutput = parsed.result;
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              emittedText += line;
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
          if (typeof parsed.result === "string" && parsed.result.length > 0) {
            finalOutput = parsed.result;
          } else {
            const candidate = extractClaudeText(parsed);
            const delta = extractDelta(candidate, emittedText);
            if (delta.length > 0) {
              emittedText += delta;
              yield { type: "token", content: delta };
            }
          }
        } catch {
          emittedText += buffer;
          yield { type: "token", content: buffer };
        }
      }

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.once("error", reject);
        proc.once("close", resolve);
      });

      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `claude CLI exited with code ${exitCode}`);
      }

      const output = (finalOutput || emittedText).trim();
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
    }
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
