import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type OnSelectionChangeParams,
} from "reactflow";
import { ChatPanel, AgentSummary } from "./ChatPanel.js";
import { NodePalette } from "./NodePalette.js";
import { RolesPanel } from "./RolesPanel.js";
import { agentTreeToGraph } from "./flowToGraph.js";
import { saveFlow } from "./api.js";
import { useRunStore, getAgentAtPath, type AgentRuntime } from "./store.js";

const SERVER_ORIGIN =
  (import.meta.env?.VITE_LOOM_SERVER as string | undefined) ?? "http://localhost:8787";

function applyAgentRuntimeState(
  nodes: Node[],
  agentRuntimes: Record<string, AgentRuntime>,
): Node[] {
  return nodes.map((node) => {
    const agentName = node.id.split("/").pop() ?? node.id;
    const runtime = agentRuntimes[agentName];
    const stateClass = runtime ? `loom-agent--state-${runtime.state}` : "";
    return {
      ...node,
      className: `${node.className ?? ""} ${stateClass}`.trim(),
    };
  });
}

function applyAgentSelection(
  nodes: Node[],
  selectedPath: string[],
): Node[] {
  const selectedId = selectedPath.join("/");
  return nodes.map((node) => {
    const isSelected = node.id === selectedId;
    const classNames = [node.className ?? ""];
    if (isSelected) classNames.push("loom-agent--selected");
    return { ...node, className: classNames.join(" ").trim() };
  });
}

function applyRuntimeEdges(
  edges: Edge[],
  agentRuntimes: Record<string, AgentRuntime>,
): Edge[] {
  return edges.map((edge) => {
    const sourceName = edge.source.split("/").pop() ?? edge.source;
    const targetName = edge.target.split("/").pop() ?? edge.target;
    const source = agentRuntimes[sourceName];
    const target = agentRuntimes[targetName];
    const active =
      source?.state === "done" && (target?.state === "running" || target?.state === "done");
    return {
      ...edge,
      animated: target?.state === "running",
      style: active
        ? { stroke: "#387548", strokeWidth: 2 }
        : edge.style,
    };
  });
}

function AgentTreeCanvas() {
  const flowDraft = useRunStore((state) => state.flowDraft);
  const agentRuntimes = useRunStore((state) => state.agentRuntimes);
  const selectedAgentPath = useRunStore((state) => state.selectedAgentPath);
  const selectAgent = useRunStore((state) => state.selectAgent);

  const baseGraph = useMemo(
    () => (flowDraft ? agentTreeToGraph(flowDraft.orchestrator) : { nodes: [], edges: [] }),
    [flowDraft],
  );

  const displayNodes = useMemo(() => {
    const withRuntime = applyAgentRuntimeState(baseGraph.nodes, agentRuntimes);
    return applyAgentSelection(withRuntime, selectedAgentPath);
  }, [baseGraph.nodes, agentRuntimes, selectedAgentPath]);

  const displayEdges = useMemo(
    () => applyRuntimeEdges(baseGraph.edges, agentRuntimes),
    [baseGraph.edges, agentRuntimes],
  );

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const first = params.nodes[0];
      if (first?.data?.agentPath) {
        selectAgent(first.data.agentPath as string[]);
      }
    },
    [selectAgent],
  );

  return (
    <div className="canvas-frame">
      <ReactFlow
        fitView
        fitViewOptions={{ padding: 0.3 }}
        nodes={displayNodes}
        edges={displayEdges}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onSelectionChange={onSelectionChange}
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
        {isSaving ? "Saving..." : isDirty ? "Save flow" : "Saved"}
      </button>
      {saveError ? <p className="save-controls__error">{saveError}</p> : null}
    </div>
  );
}

/* ── Tab Bar ───────────────────────────────────────────────────── */

function TabBar() {
  const activeTab = useRunStore((s) => s.activeTab);
  const setActiveTab = useRunStore((s) => s.setActiveTab);
  return (
    <nav className="tab-bar">
      <button
        type="button"
        className={`tab-bar__tab${activeTab === "workflow" ? " tab-bar__tab--active" : ""}`}
        onClick={() => setActiveTab("workflow")}
      >
        Workflow
      </button>
      <button
        type="button"
        className={`tab-bar__tab${activeTab === "chat" ? " tab-bar__tab--active" : ""}`}
        onClick={() => setActiveTab("chat")}
      >
        Chat
      </button>
      <button
        type="button"
        className={`tab-bar__tab${activeTab === "roles" ? " tab-bar__tab--active" : ""}`}
        onClick={() => setActiveTab("roles")}
      >
        Roles
      </button>
    </nav>
  );
}

/* ── Agent Config Panel (workflow tab right column) ────────────── */

function AgentConfigPanel() {
  const flowDraft = useRunStore((s) => s.flowDraft);
  const selectedAgentPath = useRunStore((s) => s.selectedAgentPath);
  const [expanded, setExpanded] = useState(true);

  const selectedAgent =
    flowDraft && selectedAgentPath.length > 0
      ? getAgentAtPath(flowDraft.orchestrator, selectedAgentPath)
      : undefined;

  return (
    <section className="config-panel">
      <p className="config-panel__title">Agent Config</p>
      {selectedAgent ? (
        <AgentSummary
          agent={selectedAgent}
          path={selectedAgentPath}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          key={selectedAgentPath.join("/")}
        />
      ) : (
        <p className="config-panel__empty">
          Select an agent in the tree to edit its configuration.
        </p>
      )}
    </section>
  );
}

/* ── Workflow View ─────────────────────────────────────────────── */

function WorkflowView() {
  const flowPath = useRunStore((s) => s.flowPath);
  const flowDraft = useRunStore((s) => s.flowDraft);
  const availableFlows = useRunStore((s) => s.availableFlows);
  const selectedAgentPath = useRunStore((s) => s.selectedAgentPath);
  const addAgent = useRunStore((s) => s.addAgent);
  const loadError = useRunStore((s) => s.loadError);

  const deleteFlow = useRunStore((s) => s.deleteFlow);

  const handleDeleteFlow = useCallback(async (e: React.MouseEvent, fp: string) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${fp.replace("examples/", "")}"?`)) return;
    try {
      await deleteFlow(SERVER_ORIGIN, fp);
    } catch {
      // ignore
    }
  }, [deleteFlow]);

  const selectedAgentName =
    selectedAgentPath.length > 0
      ? selectedAgentPath[selectedAgentPath.length - 1]
      : undefined;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <p className="eyebrow">Flows</p>
        <h1>Loom Studio</h1>
        <p className="sidebar-copy">
          Pick a flow, configure the agent hierarchy, and run the orchestrator live.
        </p>
        <ul className="flow-list">
          {availableFlows.length === 0 ? (
            <li className="flow-list__empty">Loading flows from server...</li>
          ) : (
            availableFlows.map((candidate) => (
              <li key={candidate} className="flow-list__item">
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
                <button
                  type="button"
                  className="flow-list__delete"
                  title="Delete flow"
                  onClick={(e) => handleDeleteFlow(e, candidate)}
                >
                  &times;
                </button>
              </li>
            ))
          )}
        </ul>
        <NodePalette
          onAdd={(type) => addAgent(selectedAgentPath, type)}
          disabled={!flowDraft}
          selectedAgentName={selectedAgentName}
        />
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
              <AgentTreeCanvas />
            </ReactFlowProvider>
          </div>
          <AgentConfigPanel />
        </div>
      </main>
    </div>
  );
}

/* ── Chat View ─────────────────────────────────────────────────── */

function ChatView() {
  const chatRepo = useRunStore((s) => s.chatRepo);
  const setChatRepo = useRunStore((s) => s.setChatRepo);
  const availableFlows = useRunStore((s) => s.availableFlows);
  const flowPath = useRunStore((s) => s.flowPath);

  return (
    <div className="chat-view">
      <aside className="chat-sidebar">
        <div className="chat-sidebar__section">
          <p className="chat-sidebar__label">Repository</p>
          <input
            type="text"
            className="chat-sidebar__input"
            placeholder="/path/to/repo"
            value={chatRepo}
            onChange={(e) => setChatRepo(e.target.value)}
          />
        </div>
        <div className="chat-sidebar__section">
          <p className="chat-sidebar__label">Flows</p>
          <ul className="flow-list">
            {availableFlows.length === 0 ? (
              <li className="flow-list__empty">No flows available</li>
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
        </div>
      </aside>
      <main className="chat-main">
        <ChatPanel hideAgentConfig />
      </main>
    </div>
  );
}

/* ── App (root) ────────────────────────────────────────────────── */

export default function App() {
  const activeTab = useRunStore((s) => s.activeTab);
  const flowPath = useRunStore((s) => s.flowPath);
  const setAvailableFlows = useRunStore((s) => s.setAvailableFlows);
  const setLoadedFlow = useRunStore((s) => s.setLoadedFlow);
  const setLoadError = useRunStore((s) => s.setLoadError);
  const fetchRoles = useRunStore((s) => s.fetchRoles);

  // Fetch roles on mount
  useEffect(() => {
    fetchRoles(SERVER_ORIGIN);
  }, [fetchRoles]);

  // Fetch available flows on mount
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

  // Load selected flow
  useEffect(() => {
    let active = true;
    setLoadedFlow(undefined);
    fetch(`${SERVER_ORIGIN}/flows/get?path=${encodeURIComponent(flowPath)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
        }
        return res.json() as Promise<{ flow: import("@loom/core").FlowDefinition }>;
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
    <div className="app-root">
      <TabBar />
      {activeTab === "workflow" && <WorkflowView />}
      {activeTab === "chat" && <ChatView />}
      {activeTab === "roles" && <RolesPanel />}
    </div>
  );
}
