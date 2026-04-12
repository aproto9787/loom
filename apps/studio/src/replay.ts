import type { PersistedNodeResult, PersistedRunSummary } from "./store.js";

export interface RunHistoryResponse {
  runs: PersistedRunSummary[];
}

export function formatJson(value: unknown): string {
  if (value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseRunHistory(payload: unknown): PersistedRunSummary[] {
  if (!payload || typeof payload !== "object") return [];
  const rawRuns = (payload as { runs?: unknown }).runs;
  if (!Array.isArray(rawRuns)) return [];
  return rawRuns
    .map((run) => parseRun(run))
    .filter((run): run is PersistedRunSummary => Boolean(run));
}

export function computeReplaySegments(nodeResults: PersistedNodeResult[]) {
  const durations = nodeResults.map((node) => {
    const startedMs = node.startedAt ? Date.parse(node.startedAt) : Number.NaN;
    const finishedMs = node.finishedAt ? Date.parse(node.finishedAt) : Number.NaN;
    return {
      nodeId: node.nodeId,
      startedMs,
      finishedMs,
      durationMs:
        Number.isNaN(startedMs) || Number.isNaN(finishedMs) ? 0 : Math.max(finishedMs - startedMs, 0),
      output: node.output,
    };
  });

  const validStarts = durations.map((node) => node.startedMs).filter((value) => !Number.isNaN(value));
  const validEnds = durations.map((node) => node.finishedMs).filter((value) => !Number.isNaN(value));
  const startMs = validStarts.length > 0 ? Math.min(...validStarts) : 0;
  const endMs = validEnds.length > 0 ? Math.max(...validEnds) : startMs;
  const totalMs = Math.max(endMs - startMs, 1);

  return durations.map((node, index) => ({
    ...node,
    sequence: index + 1,
    offsetPct: Number.isNaN(node.startedMs) ? 0 : ((node.startedMs - startMs) / totalMs) * 100,
    widthPct: node.durationMs <= 0 ? 6 : Math.max((node.durationMs / totalMs) * 100, 6),
  }));
}

function parseRun(raw: unknown): PersistedRunSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.runId !== "string" ||
    typeof candidate.flowName !== "string" ||
    typeof candidate.flowPath !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return undefined;
  }

  return {
    runId: candidate.runId,
    flowName: candidate.flowName,
    flowPath: candidate.flowPath,
    requestedInputs: isRecord(candidate.requestedInputs) ? candidate.requestedInputs : {},
    outputs: isRecord(candidate.outputs) ? candidate.outputs : {},
    createdAt: candidate.createdAt,
    nodeResults: Array.isArray(candidate.nodeResults)
      ? candidate.nodeResults.map((node) => parseNodeResult(node)).filter((node): node is PersistedNodeResult => Boolean(node))
      : [],
  };
}

function parseNodeResult(raw: unknown): PersistedNodeResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.nodeId !== "string") return undefined;
  return {
    nodeId: candidate.nodeId,
    output: candidate.output,
    startedAt: typeof candidate.startedAt === "string" ? candidate.startedAt : undefined,
    finishedAt: typeof candidate.finishedAt === "string" ? candidate.finishedAt : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
