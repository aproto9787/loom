import { useEffect, useMemo, useState } from "react";
import { formatJson, computeReplaySegments, parseRunHistory } from "./replay.js";
import { useRunStore, type NodeRuntime } from "./store.js";
import { useSseRun } from "./useSseRun.js";

const SERVER_ORIGIN =
  (import.meta.env?.VITE_LOOM_SERVER as string | undefined) ?? "http://localhost:8787";

interface McpTool {
  name: string;
  description?: string;
}

function extractMcpTools(meta: Record<string, unknown> | undefined): McpTool[] {
  if (!meta) return [];
  const mcp = meta.mcp;
  if (!mcp || typeof mcp !== "object") return [];
  const raw = (mcp as Record<string, unknown>).tools;
  if (!Array.isArray(raw)) return [];
  const tools: McpTool[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const name = candidate.name;
    if (typeof name !== "string") continue;
    const description = candidate.description;
    tools.push({
      name,
      description: typeof description === "string" ? description : undefined,
    });
  }
  return tools;
}

function McpToolList({ meta }: { meta?: Record<string, unknown> }) {
  const tools = extractMcpTools(meta);
  if (tools.length === 0) return null;
  return (
    <section className="node-mcp-tools">
      <p className="eyebrow">MCP tools ({tools.length})</p>
      <ul>
        {tools.map((tool) => (
          <li key={tool.name}>
            <code>{tool.name}</code>
            {tool.description ? <span> — {tool.description}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "queued";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatCreatedAt(createdAt: string): string {
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return createdAt;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

function NodeCard({ node }: { node: NodeRuntime }) {
  const tokens = node.tokens.join("");
  return (
    <article className={`node-card node-card--${node.state}`}>
      <header>
        <span className="node-id">{node.id}</span>
        {node.type ? <span className="node-type">{node.type}</span> : null}
        <span className="node-duration">{formatDuration(node.durationMs)}</span>
        <span className={`node-state node-state--${node.state}`}>{node.state}</span>
      </header>
      {tokens ? <pre className="node-tokens">{tokens}</pre> : null}
      <McpToolList meta={node.meta} />
      {node.output !== undefined ? <pre className="node-output">{formatJson(node.output)}</pre> : null}
      {node.error ? <p className="node-error">{node.error}</p> : null}
    </article>
  );
}

function RunHistoryDrawer() {
  const runHistory = useRunStore((state) => state.runHistory);
  const selectedRunId = useRunStore((state) => state.selectedRunId);
  const selectRun = useRunStore((state) => state.selectRun);
  const isStreaming = useRunStore((state) => state.isStreaming);

  return (
    <section className="run-history">
      <div className="run-history__header">
        <div>
          <p className="eyebrow">Run history</p>
          <h3>Replay saved runs</h3>
        </div>
        <span className="run-history__count">{runHistory.length}</span>
      </div>
      <div className="run-history__list">
        {runHistory.length === 0 ? (
          <p className="run-empty">No persisted runs yet.</p>
        ) : (
          runHistory.map((run) => (
            <button
              key={run.runId}
              type="button"
              className={run.runId === selectedRunId ? "run-history__item run-history__item--active" : "run-history__item"}
              onClick={() => selectRun(run.runId)}
              disabled={isStreaming}
            >
              <span className="run-history__flow">{run.flowName}</span>
              <span className="run-history__meta">{run.flowPath.replace("examples/", "")}</span>
              <span className="run-history__meta">{formatCreatedAt(run.createdAt)}</span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function ReplayTimeline() {
  const isStreaming = useRunStore((state) => state.isStreaming);
  const runHistory = useRunStore((state) => state.runHistory);
  const selectedRunId = useRunStore((state) => state.selectedRunId);
  const replaySelectedNodeId = useRunStore((state) => state.replaySelectedNodeId);
  const selectReplayNode = useRunStore((state) => state.selectReplayNode);

  const selectedRun = useMemo(
    () => runHistory.find((run) => run.runId === selectedRunId),
    [runHistory, selectedRunId],
  );
  const segments = useMemo(
    () => (selectedRun ? computeReplaySegments(selectedRun.nodeResults) : []),
    [selectedRun],
  );

  if (!selectedRun || segments.length === 0 || isStreaming) {
    return null;
  }

  return (
    <section className="replay-timeline">
      <div className="replay-timeline__header">
        <div>
          <p className="eyebrow">Replay timeline</p>
          <h3>{selectedRun.flowName}</h3>
        </div>
        <code>{selectedRun.runId}</code>
      </div>
      <div className="replay-timeline__track">
        {segments.map((segment) => (
          <button
            key={segment.nodeId}
            type="button"
            className={segment.nodeId === replaySelectedNodeId ? "replay-chip replay-chip--active" : "replay-chip"}
            style={{ left: `${segment.offsetPct}%`, width: `${segment.widthPct}%` }}
            onClick={() => selectReplayNode(segment.nodeId)}
            title={`${segment.nodeId} · ${formatDuration(segment.durationMs)}`}
          >
            <span>{segment.sequence}</span>
            <strong>{segment.nodeId}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

export function RunPanel() {
  const flowPath = useRunStore((state) => state.flowPath);
  const inputsJson = useRunStore((state) => state.inputsJson);
  const isStreaming = useRunStore((state) => state.isStreaming);
  const flowName = useRunStore((state) => state.flowName);
  const runId = useRunStore((state) => state.runId);
  const nodeRuntimes = useRunStore((state) => state.nodeRuntimes);
  const finalOutputs = useRunStore((state) => state.finalOutputs);
  const runError = useRunStore((state) => state.runError);
  const setFlowPath = useRunStore((state) => state.setFlowPath);
  const setInputsJson = useRunStore((state) => state.setInputsJson);
  const setRunHistory = useRunStore((state) => state.setRunHistory);

  const { runFlow } = useSseRun();
  const [historyError, setHistoryError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    fetch(`${SERVER_ORIGIN}/runs?page=1&pageSize=20`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(async (payload) => {
        if (!active) return;
        const summaries = Array.isArray((payload as { runs?: unknown }).runs)
          ? ((payload as { runs: Array<{ runId: string }> }).runs ?? [])
          : [];
        const details = await Promise.all(
          summaries.map(async (run) => {
            const response = await fetch(`${SERVER_ORIGIN}/runs/${encodeURIComponent(run.runId)}`);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            return response.json();
          }),
        );
        setRunHistory(parseRunHistory({ runs: details }));
        setHistoryError(undefined);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setHistoryError(error instanceof Error ? error.message : "failed to load run history");
      });
    return () => {
      active = false;
    };
  }, [setRunHistory]);

  const orderedNodes = useMemo(() => Object.values(nodeRuntimes), [nodeRuntimes]);

  const handleRun = async () => {
    let inputs: Record<string, unknown> = {};
    try {
      inputs = inputsJson.trim() ? (JSON.parse(inputsJson) as Record<string, unknown>) : {};
    } catch (error) {
      useRunStore.getState().ingest({
        kind: "run_error",
        message: `Invalid inputs JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    await runFlow(flowPath, inputs);

    try {
      const response = await fetch(`${SERVER_ORIGIN}/runs?page=1&pageSize=20`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { runs?: Array<{ runId: string }> };
      const details = await Promise.all(
        (payload.runs ?? []).map(async (run) => {
          const detailResponse = await fetch(`${SERVER_ORIGIN}/runs/${encodeURIComponent(run.runId)}`);
          if (!detailResponse.ok) {
            throw new Error(`HTTP ${detailResponse.status}`);
          }
          return detailResponse.json();
        }),
      );
      setRunHistory(parseRunHistory({ runs: details }));
      setHistoryError(undefined);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "failed to refresh run history");
    }
  };

  return (
    <section className="run-panel">
      <header className="run-panel__header">
        <div>
          <p className="eyebrow">Run</p>
          <h2>{flowName ?? "No flow run yet"}</h2>
          {runId ? <code className="run-id">{runId}</code> : null}
        </div>
        <button type="button" onClick={handleRun} disabled={isStreaming}>
          {isStreaming ? "Streaming…" : "Run flow"}
        </button>
      </header>

      <div className="run-panel__controls">
        <label>
          <span>Flow path</span>
          <input
            type="text"
            value={flowPath}
            onChange={(event) => setFlowPath(event.target.value)}
            disabled={isStreaming}
          />
        </label>
        <label>
          <span>Inputs (JSON)</span>
          <textarea
            value={inputsJson}
            onChange={(event) => setInputsJson(event.target.value)}
            rows={5}
            disabled={isStreaming}
            spellCheck={false}
          />
        </label>
      </div>

      <RunHistoryDrawer />
      <ReplayTimeline />

      {runError ? <p className="run-error">{runError}</p> : null}
      {historyError ? <p className="run-error">Replay history: {historyError}</p> : null}

      <div className="run-panel__nodes">
        {orderedNodes.length === 0 ? (
          <p className="run-empty">Press Run flow to stream events from the Loom server.</p>
        ) : (
          orderedNodes.map((node) => <NodeCard key={node.id} node={node} />)
        )}
      </div>

      {finalOutputs ? (
        <div className="run-panel__outputs">
          <p className="eyebrow">Outputs</p>
          <pre>{formatJson(finalOutputs)}</pre>
        </div>
      ) : null}
    </section>
  );
}
