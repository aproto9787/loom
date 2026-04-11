import { useEffect, useMemo } from "react";
import { Background, Controls, ReactFlow } from "reactflow";
import { RunPanel } from "./RunPanel.js";
import { flowToGraph } from "./flowToGraph.js";
import { useRunStore, type NodeRuntime } from "./store.js";

const SERVER_ORIGIN = (import.meta.env?.VITE_LOOM_SERVER as string | undefined) ?? "http://localhost:8787";

function applyRuntimeState(
  nodes: ReturnType<typeof flowToGraph>["nodes"],
  nodeRuntimes: Record<string, NodeRuntime>,
) {
  return nodes.map((node) => {
    const runtime = nodeRuntimes[node.id];
    const stateClass = runtime ? `loom-node--state-${runtime.state}` : "";
    return {
      ...node,
      className: `${node.className ?? ""} ${stateClass}`.trim(),
    };
  });
}

function applyRuntimeEdges(
  edges: ReturnType<typeof flowToGraph>["edges"],
  nodeRuntimes: Record<string, NodeRuntime>,
) {
  return edges.map((edge) => {
    const source = nodeRuntimes[edge.source];
    const target = nodeRuntimes[edge.target];
    const active =
      source?.state === "done" && (target?.state === "running" || target?.state === "done");
    return {
      ...edge,
      animated: target?.state === "running",
      style: active ? { stroke: "#6b3e19", strokeWidth: 2 } : edge.style,
    };
  });
}

export default function App() {
  const flowPath = useRunStore((state) => state.flowPath);
  const loadedFlow = useRunStore((state) => state.loadedFlow);
  const nodeRuntimes = useRunStore((state) => state.nodeRuntimes);
  const availableFlows = useRunStore((state) => state.availableFlows);
  const setAvailableFlows = useRunStore((state) => state.setAvailableFlows);
  const setLoadedFlow = useRunStore((state) => state.setLoadedFlow);
  const setLoadError = useRunStore((state) => state.setLoadError);

  // Fetch the list of flows once on mount.
  useEffect(() => {
    let active = true;
    fetch(`${SERVER_ORIGIN}/flows`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { flows: string[] }) => {
        if (active) setAvailableFlows(data.flows ?? []);
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(error instanceof Error ? error.message : "failed to list flows");
      });
    return () => {
      active = false;
    };
  }, [setAvailableFlows, setLoadError]);

  // Fetch and parse the currently selected flow whenever flowPath changes.
  useEffect(() => {
    let active = true;
    setLoadedFlow(undefined);
    fetch(`${SERVER_ORIGIN}/flows/get?path=${encodeURIComponent(flowPath)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
        }
        return res.json() as Promise<{ flow: Parameters<typeof flowToGraph>[0] }>;
      })
      .then((data) => {
        if (active) setLoadedFlow(data.flow);
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(error instanceof Error ? error.message : "failed to load flow");
      });
    return () => {
      active = false;
    };
  }, [flowPath, setLoadedFlow, setLoadError]);

  const graph = useMemo(() => (loadedFlow ? flowToGraph(loadedFlow) : { nodes: [], edges: [] }), [loadedFlow]);

  const displayNodes = useMemo(
    () => applyRuntimeState(graph.nodes, nodeRuntimes),
    [graph.nodes, nodeRuntimes],
  );

  const displayEdges = useMemo(
    () => applyRuntimeEdges(graph.edges, nodeRuntimes),
    [graph.edges, nodeRuntimes],
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="eyebrow">Flows</p>
        <h1>Loom Studio</h1>
        <p className="sidebar-copy">
          Pick a flow, stream it, and watch the graph light up as the backend reduces
          each node.
        </p>
        <ul className="flow-list">
          {availableFlows.length === 0 ? (
            <li className="flow-list__empty">Loading examples from the server…</li>
          ) : (
            availableFlows.map((candidate) => (
              <li key={candidate}>
                <button
                  type="button"
                  className={candidate === flowPath ? "flow-list__button flow-list__button--active" : "flow-list__button"}
                  onClick={() => useRunStore.getState().setFlowPath(candidate)}
                >
                  {candidate.replace("examples/", "")}
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>
      <main className="canvas-shell">
        <div className="canvas-header">{loadedFlow ? loadedFlow.name : "Loom Studio"}</div>
        <div className="canvas-body">
          <div className="canvas-frame">
            <ReactFlow
              fitView
              fitViewOptions={{ padding: 0.2 }}
              nodes={displayNodes}
              edges={displayEdges}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
            >
              <Background gap={20} size={1.1} color="#d9d6cf" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <RunPanel />
        </div>
      </main>
    </div>
  );
}
