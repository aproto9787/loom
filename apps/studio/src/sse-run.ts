import type { RunStreamEvent } from "./store.js";

interface SseBlock {
  event: string;
  data: string;
}

export const SERVER_ORIGIN =
  (import.meta.env?.VITE_LOOM_SERVER as string | undefined) ?? "http://localhost:8787";

export function parseSseChunk(buffer: string): { blocks: SseBlock[]; rest: string } {
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

export function toRunStreamEvent(block: SseBlock): RunStreamEvent | undefined {
  try {
    const payload = JSON.parse(block.data);
    return { kind: block.event, ...payload } as RunStreamEvent;
  } catch {
    return undefined;
  }
}
