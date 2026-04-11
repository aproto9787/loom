import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { InvokeContext, InvokeEvent, RuntimeAdapter, RuntimeSession } from "@loom/core";

export const litellmAdapterId = "litellm";

const LOCAL_LITELLM_BASE_URL = "http://127.0.0.1:4000";

function getTopic(ctx: InvokeContext): string {
  return typeof ctx.resolvedInputs.topic === "string"
    ? ctx.resolvedInputs.topic
    : typeof ctx.resolvedInputs.prompt === "string"
      ? ctx.resolvedInputs.prompt
      : "anything";
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

function extractDeltaText(line: string): string | undefined {
  if (!line.startsWith("data:")) {
    return undefined;
  }

  const payload = line.slice("data:".length).trim();
  if (payload.length === 0 || payload === "[DONE]") {
    return undefined;
  }

  const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
  const text = parsed.choices?.[0]?.delta?.content;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

async function* streamFromLiteLLM(baseUrl: string, model: string, topic: string): AsyncIterable<string> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: topic }],
    }),
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
      const text = extractDeltaText(rawLine.trim());
      if (text) {
        yield text;
      }
    }
  }

  const trailing = extractDeltaText(buffer.trim());
  if (trailing) {
    yield trailing;
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
      const reply = `LiteLLM(${model}) replies about ${topic}.`;
      const words = reply.split(" ");
      for (let index = 0; index < words.length; index += 1) {
        const chunk = index === 0 ? words[index] : ` ${words[index]}`;
        yield { kind: "token", text: chunk };
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

      let reply = "";
      for await (const chunk of streamFromLiteLLM(baseUrl, model, topic)) {
        reply += chunk;
        yield { kind: "token", text: chunk };
      }

      if (reply.length === 0) {
        throw new Error("litellm stream returned no text");
      }

      yield { kind: "final", output: reply };
    } catch (error) {
      yield {
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

export const litellmAdapter = new LitellmAdapter();
