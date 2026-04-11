import { useMemo } from "react";
import { useRunStore, type NodeRuntime } from "./store.js";
import { useSseRun } from "./useSseRun.js";

function formatOutput(output: unknown): string {
  if (output === undefined) {
    return "—";
  }
  if (typeof output === "string") {
    return output;
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

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

function NodeCard({ node }: { node: NodeRuntime }) {
  const tokens = node.tokens.join("");
  return (
    <article className={`node-card node-card--${node.state}`}>
      <header>
        <span className="node-id">{node.id}</span>
        {node.type ? <span className="node-type">{node.type}</span> : null}
        <span className={`node-state node-state--${node.state}`}>{node.state}</span>
      </header>
      {tokens ? <pre className="node-tokens">{tokens}</pre> : null}
      <McpToolList meta={node.meta} />
      {node.output !== undefined ? (
        <pre className="node-output">{formatOutput(node.output)}</pre>
      ) : null}
      {node.error ? <p className="node-error">{node.error}</p> : null}
    </article>
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

  const { runFlow } = useSseRun();

  const orderedNodes = useMemo(() => {
    return Object.values(nodeRuntimes);
  }, [nodeRuntimes]);

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

      {runError ? <p className="run-error">{runError}</p> : null}

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
          <pre>{formatOutput(finalOutputs)}</pre>
        </div>
      ) : null}
    </section>
  );
}
