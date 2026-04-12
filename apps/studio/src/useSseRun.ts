import { useCallback } from "react";
import { useRunStore, type RunStreamEvent } from "./store.js";

const SERVER_ORIGIN =
  (import.meta.env?.VITE_LOOM_SERVER as string | undefined) ?? "http://localhost:8787";

interface SseBlock {
  event: string;
  data: string;
}

function parseSseChunk(buffer: string): { blocks: SseBlock[]; rest: string } {
  const blocks: SseBlock[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const delimiter = buffer.indexOf("\n\n", cursor);
    if (delimiter === -1) break;
    const rawBlock = buffer.slice(cursor, delimiter);
    cursor = delimiter + 2;
    let event = "message";
    let data = "";
    for (const line of rawBlock.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice("event: ".length).trim();
      } else if (line.startsWith("data: ")) {
        data += (data ? "\n" : "") + line.slice("data: ".length);
      }
    }
    blocks.push({ event, data });
  }

  return { blocks, rest: buffer.slice(cursor) };
}

function toRunStreamEvent(block: SseBlock): RunStreamEvent | undefined {
  try {
    const payload = JSON.parse(block.data);
    return { kind: block.event, ...payload } as RunStreamEvent;
  } catch {
    return undefined;
  }
}

export function useSseRun() {
  const beginStream = useRunStore((state) => state.beginStream);
  const ingest = useRunStore((state) => state.ingest);
  const endStream = useRunStore((state) => state.endStream);

  const runFlow = useCallback(
    async (flowPath: string, userPrompt: string) => {
      beginStream();

      let response: Response;
      try {
        response = await fetch(`${SERVER_ORIGIN}/runs/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ flowPath, userPrompt }),
        });
      } catch (error) {
        ingest({
          kind: "run_error",
          message: error instanceof Error ? error.message : String(error),
        });
        endStream();
        return;
      }

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        ingest({
          kind: "run_error",
          message: `HTTP ${response.status}${text ? `: ${text}` : ""}`,
        });
        endStream();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { blocks, rest } = parseSseChunk(buffer);
          buffer = rest;
          for (const block of blocks) {
            const event = toRunStreamEvent(block);
            if (event) ingest(event);
          }
        }
      } catch (error) {
        ingest({
          kind: "run_error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        endStream();
      }
    },
    [beginStream, ingest, endStream],
  );

  return { runFlow };
}
