import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { InvokeContext, InvokeEvent, McpInvokeServer, RuntimeAdapter, RuntimeSession } from "@loom/core";

export const litellmAdapterId = "litellm";

const LOCAL_LITELLM_BASE_URL = "http://127.0.0.1:4000";

function getTopic(ctx: InvokeContext): string {
  return typeof ctx.resolvedInputs.topic === "string"
    ? ctx.resolvedInputs.topic
    : typeof ctx.resolvedInputs.prompt === "string"
      ? ctx.resolvedInputs.prompt
      : "anything";
}

function getFirstMcpServer(ctx: InvokeContext): [string, McpInvokeServer] | undefined {
  return ctx.mcps ? Object.entries(ctx.mcps)[0] : undefined;
}

function buildMockToolArgs(topic: string): { text: string } {
  return { text: `mock tool input: ${topic}` };
}

function buildOpenAiTools(ctx: InvokeContext): Array<Record<string, unknown>> {
  return Object.entries(ctx.mcps ?? {}).flatMap(([serverId, server]) => server.tools.map((tool) => ({
    type: "function",
    function: {
      name: `${serverId}__${tool.name}`,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: "object", additionalProperties: true },
    },
  })));
}

function parseQualifiedToolName(name: string): { serverId: string; toolName: string } {
  const divider = name.indexOf("__");
  if (divider === -1) {
    throw new Error(`invalid LiteLLM tool name: ${name}`);
  }
  return {
    serverId: name.slice(0, divider),
    toolName: name.slice(divider + 2),
  };
}

async function waitForProxyReady(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health/liveliness`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the proxy boots.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out waiting for LiteLLM proxy at ${baseUrl}`);
}

async function stopProxy(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }

  proc.kill("SIGTERM");
  try {
    await Promise.race([once(proc, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  } catch {
    /* ignore */
  }

  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
  }
}

function getSpawnedProxy(runtime: RuntimeSession | undefined): Promise<string> | undefined {
  if (!runtime || process.env.LOOM_LITELLM_SPAWN !== "1") {
    return undefined;
  }

  return runtime.getOrCreateResource("litellm:spawned-proxy", () => (async () => {
    const proc = spawn("litellm", ["--host", "127.0.0.1", "--port", "4000"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (!proc.stdout || !proc.stderr) {
      throw new Error("litellm spawn did not provide stdio pipes");
    }

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.resume();
    proc.stderr.resume();

    runtime.registerCleanup(() => stopProxy(proc));

    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error("litellm proxy exited before it became ready");
    }

    await waitForProxyReady(LOCAL_LITELLM_BASE_URL);
    return LOCAL_LITELLM_BASE_URL;
  })());
}

async function resolveBaseUrl(runtime: RuntimeSession | undefined): Promise<string | undefined> {
  if (process.env.LOOM_LITELLM_URL) {
    return process.env.LOOM_LITELLM_URL;
  }

  if (process.env.LOOM_LITELLM_SPAWN === "1") {
    const probe = spawnSync("litellm", ["--version"], { stdio: "ignore" });
    if (probe.error) {
      throw new Error("LOOM_LITELLM_SPAWN=1 but litellm binary is not on PATH");
    }
  }

  const spawned = getSpawnedProxy(runtime);
  if (spawned) {
    return spawned;
  }

  return undefined;
}

function parseSsePayload(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("data:")) {
    return undefined;
  }

  const payload = line.slice("data:".length).trim();
  if (payload.length === 0 || payload === "[DONE]") {
    return undefined;
  }

  return JSON.parse(payload) as Record<string, unknown>;
}

async function streamLiteLLMCompletion(
  baseUrl: string,
  body: Record<string, unknown>,
  onChunk: (chunk: Record<string, unknown>) => Promise<void> | void,
): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    throw new Error(`litellm proxy request failed: ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const parsed = parseSsePayload(rawLine.trim());
      if (parsed) {
        await onChunk(parsed);
      }
    }
  }

  const trailing = parseSsePayload(buffer.trim());
  if (trailing) {
    await onChunk(trailing);
  }
}

class LitellmAdapter implements RuntimeAdapter {
  readonly id = litellmAdapterId;

  supports(nodeType: string): boolean {
    return nodeType === "agent.litellm";
  }

  async *invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    const topic = getTopic(ctx);
    const model = typeof ctx.node.config.model === "string" ? ctx.node.config.model : "unknown-model";

    if (process.env.LOOM_MOCK === "1") {
      const firstServer = getFirstMcpServer(ctx);
      if (!firstServer) {
        const reply = `LiteLLM(${model}) replies about ${topic}.`;
        const words = reply.split(" ");
        for (let index = 0; index < words.length; index += 1) {
          const chunk = index === 0 ? words[index] : ` ${words[index]}`;
          yield { kind: "token", text: chunk };
        }
        yield { kind: "final", output: reply };
        return;
      }

      const [, server] = firstServer;
      const tool = server.tools[0];
      if (!tool) {
        throw new Error("mock LiteLLM MCP server exposes no tools");
      }
      const args = buildMockToolArgs(topic);
      yield { kind: "tool_call", name: tool.name, args };
      const result = await server.callTool(tool.name, args);
      yield { kind: "tool_result", name: tool.name, result };
      const reply = `LiteLLM(${model}) replies about ${topic}.\n[tool_call] ${JSON.stringify({ name: tool.name, arguments: args })}\n[tool_result] ${JSON.stringify(result)}`;
      for (const part of reply.split(/(\s+)/)) {
        if (part.length > 0) {
          yield { kind: "token", text: part };
        }
      }
      yield { kind: "final", output: reply };
      return;
    }

    try {
      const baseUrl = await resolveBaseUrl(ctx.runtime);
      if (!baseUrl) {
        const reply = `LiteLLM(${model}) replies about ${topic}.`;
        const words = reply.split(" ");
        for (let index = 0; index < words.length; index += 1) {
          const chunk = index === 0 ? words[index] : ` ${words[index]}`;
          yield { kind: "token", text: chunk };
        }
        yield { kind: "final", output: reply };
        return;
      }

      const tools = buildOpenAiTools(ctx);
      const messages: Array<Record<string, unknown>> = [{ role: "user", content: topic }];
      let reply = "";

      while (true) {
        let pendingToolCall:
          | { id: string; name: string; argumentsText: string }
          | undefined;

        const streamedTokens: string[] = [];
        await streamLiteLLMCompletion(baseUrl, {
          model,
          stream: true,
          messages,
          tools: tools.length > 0 ? tools : undefined,
        }, async (chunk) => {
          const choice = Array.isArray(chunk.choices) ? chunk.choices[0] as Record<string, unknown> : undefined;
          const delta = choice?.delta as Record<string, unknown> | undefined;
          const content = delta?.content;
          if (typeof content === "string" && content.length > 0) {
            reply += content;
            streamedTokens.push(content);
          }
          const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : [];
          for (const toolCall of toolCalls) {
            const callId = typeof toolCall.id === "string" ? toolCall.id : pendingToolCall?.id ?? "call_0";
            const fn = toolCall.function as Record<string, unknown> | undefined;
            const fnName = typeof fn?.name === "string" ? fn.name : pendingToolCall?.name;
            const argumentsText = typeof fn?.arguments === "string"
              ? `${pendingToolCall?.argumentsText ?? ""}${fn.arguments}`
              : pendingToolCall?.argumentsText ?? "";
            if (fnName) {
              pendingToolCall = { id: callId, name: fnName, argumentsText };
            }
          }
        });
        for (const token of streamedTokens) {
          yield { kind: "token", text: token };
        }

        if (!pendingToolCall) {
          if (reply.length === 0) {
            throw new Error("litellm stream returned no text");
          }
          yield { kind: "final", output: reply };
          return;
        }

        const { serverId, toolName } = parseQualifiedToolName(pendingToolCall.name);
        const server = ctx.mcps?.[serverId];
        if (!server) {
          throw new Error(`LiteLLM tool requested unknown MCP server ${serverId}`);
        }
        const parsedArgs = pendingToolCall.argumentsText.length > 0
          ? JSON.parse(pendingToolCall.argumentsText)
          : {};
        yield { kind: "tool_call", name: toolName, args: parsedArgs };
        const result = await server.callTool(toolName, parsedArgs);
        yield { kind: "tool_result", name: toolName, result };
        messages.push({ role: "assistant", content: reply, tool_calls: [{
          id: pendingToolCall.id,
          type: "function",
          function: { name: pendingToolCall.name, arguments: pendingToolCall.argumentsText },
        }] });
        messages.push({
          role: "tool",
          tool_call_id: pendingToolCall.id,
          content: JSON.stringify(result),
        });
      }
    } catch (error) {
      yield {
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

export const litellmAdapter = new LitellmAdapter();
