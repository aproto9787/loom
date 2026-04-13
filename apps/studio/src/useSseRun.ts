import { useCallback } from "react";
import { useRunStore } from "./store.js";
import { SERVER_ORIGIN, parseSseChunk, toRunStreamEvent } from "./chat-run.js";

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

  const abortFlow = useCallback(async (runId: string) => {
    const response = await fetch(`${SERVER_ORIGIN}/runs/${runId}/abort`, {
      method: "POST",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ""}`);
    }
  }, []);

  return { runFlow, abortFlow };
}
