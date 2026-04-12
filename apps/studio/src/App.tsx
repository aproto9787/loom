import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from "reactflow";
import { RunPanel } from "./RunPanel.js";
import { NodePalette } from "./NodePalette.js";
import { Inspector } from "./Inspector.js";
import { flowToGraph } from "./flowToGraph.js";
import { saveFlow } from "./api.js";
import { useRunStore, type EditableNodeType, type NodeRuntime } from "./store.js";

const SERVER_ORIGIN =
  (import.meta.env?.VITE_LOOM_SERVER as string | undefined) ?? "http://localhost:8787";

function applyRuntimeState(nodes: Node[], nodeRuntimes: Record<string, NodeRuntime>): Node[] {
  return nodes.map((node) => {
    const runtime = nodeRuntimes[node.id];
    const stateClass = runtime ? `loom-node--state-${runtime.state}` : "";
    return {
      ...node,
      className: `${node.className ?? ""} ${stateClass}`.trim(),
    };
  });
}

function applyRuntimeEdges(edges: Edge[], nodeRuntimes: Record<string, NodeRuntime>): Edge[] {
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

function applySelection(
  nodes: Node[],
  selectedId: string | undefined,
  replaySelectedId: string | undefined,
): Node[] {
  return nodes.map((node) => {
    const selected = node.id === selectedId;
    const replaySelected = node.id === replaySelectedId;
    const classNames = [node.className ?? ""];
    if (selected) classNames.push("loom-node--selected");
    if (replaySelected) classNames.push("loom-node--replay-selected");
    return { ...node, className: classNames.join(" ").trim() };
  });
}

function EditorCanvas() {
  const flowDraft = useRunStore((state) => state.flowDraft);
  const nodeRuntimes = useRunStore((state) => state.nodeRuntimes);
  const selectedNodeId = useRunStore((state) => state.selectedNodeId);
  const replaySelectedNodeId = useRunStore((state) => state.replaySelectedNodeId);
  const selectedRunId = useRunStore((state) => state.selectedRunId);
  const positionOverrides = useRunStore((state) => state.nodePositionOverrides);
  const addNode = useRunStore((state) => state.addNode);
  const deleteNode = useRunStore((state) => state.deleteNode);
  const connectNodes = useRunStore((state) => state.connectNodes);
  const disconnectEdge = useRunStore((state) => state.disconnectEdge);
  const selectNode = useRunStore((state) => state.selectNode);
  const setNodePosition = useRunStore((state) => state.setNodePosition);

  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const baseGraph = useMemo(
    () => (flowDraft ? flowToGraph(flowDraft) : { nodes: [], edges: [] }),
    [flowDraft],
  );

  const displayNodes = useMemo(() => {
    const withOverrides = baseGraph.nodes.map((node) => {
      const override = positionOverrides[node.id];
      return override ? { ...node, position: override } : node;
    });
    const withRuntime = applyRuntimeState(withOverrides, nodeRuntimes);
    return applySelection(withRuntime, selectedNodeId, selectedRunId ? replaySelectedNodeId : undefined);
  }, [baseGraph.nodes, positionOverrides, nodeRuntimes, selectedNodeId, replaySelectedNodeId, selectedRunId]);

  const displayEdges = useMemo(
    () => applyRuntimeEdges(baseGraph.edges, nodeRuntimes),
    [baseGraph.edges, nodeRuntimes],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Apply changes to a transient copy just to read the resulting positions.
      const next = applyNodeChanges(changes, displayNodes);
      const positionChanges = changes.filter(
        (change) => change.type === "position" && change.position,
      );
      for (const change of positionChanges) {
        if (change.type !== "position" || !change.position) continue;
        setNodePosition(change.id, { x: change.position.x, y: change.position.y });
      }
      const removeChanges = changes.filter((change) => change.type === "remove");
      for (const change of removeChanges) {
        if (change.type === "remove") deleteNode(change.id);
      }
      void next;
    },
    [displayNodes, setNodePosition, deleteNode],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const next = applyEdgeChanges(changes, displayEdges);
      for (const change of changes) {
        if (change.type === "remove") {
          const edge = displayEdges.find((candidate) => candidate.id === change.id);
          if (edge) disconnectEdge(edge.source, edge.target);
        }
      }
      void next;
    },
    [displayEdges, disconnectEdge],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      connectNodes(connection.source, connection.target);
    },
    [connectNodes],
  );

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const first = params.nodes[0];
      selectNode(first?.id);
    },
    [selectNode],
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/loom-node-type") as EditableNodeType;
      if (!type) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode(type, position);
    },
    [addNode, screenToFlowPosition],
  );

  return (
    <div className="canvas-frame" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
      <ReactFlow
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodes={displayNodes}
        edges={displayEdges}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        deleteKeyCode={["Delete", "Backspace"]}
      >
        <Background gap={20} size={1.1} color="#d9d6cf" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function SaveControls() {
  const flowPath = useRunStore((state) => state.flowPath);
  const flowDraft = useRunStore((state) => state.flowDraft);
  const isDirty = useRunStore((state) => state.isDirty);
  const isSaving = useRunStore((state) => state.isSaving);
  const saveError = useRunStore((state) => state.saveError);
  const beginSave = useRunStore((state) => state.beginSave);
  const endSave = useRunStore((state) => state.endSave);
  const setSaveError = useRunStore((state) => state.setSaveError);

  const handleSave = useCallback(async () => {
    if (!flowDraft || !isDirty || isSaving) return;
    beginSave();
    try {
      await saveFlow(SERVER_ORIGIN, flowPath, flowDraft);
      endSave(flowDraft);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "save failed");
    }
  }, [flowDraft, isDirty, isSaving, flowPath, beginSave, endSave, setSaveError]);

  return (
    <div className="save-controls">
      <button
        type="button"
        className="save-controls__button"
        onClick={handleSave}
        disabled={!flowDraft || !isDirty || isSaving}
      >
        {isSaving ? "Saving…" : isDirty ? "Save flow" : "Saved"}
      </button>
      {saveError ? <p className="save-controls__error">{saveError}</p> : null}
    </div>
  );
}

export default function App() {
  const flowPath = useRunStore((state) => state.flowPath);
  const flowDraft = useRunStore((state) => state.flowDraft);
  const availableFlows = useRunStore((state) => state.availableFlows);
  const setAvailableFlows = useRunStore((state) => state.setAvailableFlows);
  const setLoadedFlow = useRunStore((state) => state.setLoadedFlow);
  const setLoadError = useRunStore((state) => state.setLoadError);
  const addNode = useRunStore((state) => state.addNode);
  const loadError = useRunStore((state) => state.loadError);

  // Fetch the list of flows once on mount.
  useEffect(() => {
    let active = true;
    fetch(`${SERVER_ORIGIN}/flows`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { flows: string[] }) => {
        if (active) setAvailableFlows(data.flows ?? []);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "failed to list flows");
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
        if (active) setLoadError(error instanceof Error ? error.message : "failed to load flow");
      });
    return () => {
      active = false;
    };
  }, [flowPath, setLoadedFlow, setLoadError]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="eyebrow">Flows</p>
        <h1>Loom Studio</h1>
        <p className="sidebar-copy">
          Pick a flow, edit the graph, and stream it live while the backend reduces each node.
        </p>
        <ul className="flow-list">
          {availableFlows.length === 0 ? (
            <li className="flow-list__empty">Loading examples from the server…</li>
          ) : (
            availableFlows.map((candidate) => (
              <li key={candidate}>
                <button
                  type="button"
                  className={
                    candidate === flowPath
                      ? "flow-list__button flow-list__button--active"
                      : "flow-list__button"
                  }
                  onClick={() => useRunStore.getState().setFlowPath(candidate)}
                >
                  {candidate.replace("examples/", "")}
                </button>
              </li>
            ))
          )}
        </ul>
        <NodePalette onAdd={addNode} disabled={!flowDraft} />
      </aside>
      <main className="canvas-shell">
        <div className="canvas-header">
          <span>{flowDraft ? flowDraft.name : "Loom Studio"}</span>
          <SaveControls />
        </div>
        {loadError ? <p className="canvas-load-error">{loadError}</p> : null}
        <div className="canvas-body">
          <div className="canvas-column">
            <ReactFlowProvider>
              <EditorCanvas />
            </ReactFlowProvider>
            <Inspector />
          </div>
          <RunPanel />
        </div>
      </main>
    </div>
  );
}
