import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "reactflow";
import { ChatPanel, AgentSummary } from "./ChatPanel.js";
import { NodePalette } from "./NodePalette.js";
import { RolesPanel } from "./RolesPanel.js";
import { CustomPanel } from "./CustomPanel.js";
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
  return nodes.map((node) => ({
    ...node,
    className: `${node.className ?? ""} ${node.id === selectedId ? "loom-agent--selected" : ""}`.trim(),
  }));
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
      style: active ? { stroke: "#22c55e", strokeWidth: 2 } : edge.style,
    };
  });
}

/* ── Agent Tree Canvas ────────────────────────────────────────── */

function AgentTreeCanvas() {
  const flowDraft = useRunStore((s) => s.flowDraft);
  const agentRuntimes = useRunStore((s) => s.agentRuntimes);
  const selectedAgentPath = useRunStore((s) => s.selectedAgentPath);
  const selectAgent = useRunStore((s) => s.selectAgent);

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

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.data?.agentPath) {
        selectAgent(node.data.agentPath as string[]);
      }
    },
    [selectAgent],
  );

  return (
    <div className="flex flex-1 min-h-[280px]">
      <ReactFlow
        fitView
        fitViewOptions={{ padding: 0.3 }}
        nodes={displayNodes}
        edges={displayEdges}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={onNodeClick}
      >
        <Background gap={20} size={1} color="#cbd5e1" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/* ── Save Controls ────────────────────────────────────────────── */

function SaveControls() {
  const flowPath = useRunStore((s) => s.flowPath);
  const flowDraft = useRunStore((s) => s.flowDraft);
  const isDirty = useRunStore((s) => s.isDirty);
  const isSaving = useRunStore((s) => s.isSaving);
  const saveError = useRunStore((s) => s.saveError);
  const beginSave = useRunStore((s) => s.beginSave);
  const endSave = useRunStore((s) => s.endSave);
  const setSaveError = useRunStore((s) => s.setSaveError);

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
    <div className="flex items-center gap-3">
      <button
        type="button"
        className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-40 transition-colors"
        onClick={handleSave}
        disabled={!flowDraft || !isDirty || isSaving}
      >
        {isSaving ? "Saving..." : isDirty ? "Save flow" : "Saved"}
      </button>
      {saveError ? (
        <p className="m-0 px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs">{saveError}</p>
      ) : null}
    </div>
  );
}

/* ── Tab Bar ──────────────────────────────────────────────────── */

const TABS = ["workflow", "chat", "roles", "custom"] as const;

function TabBar() {
  const activeTab = useRunStore((s) => s.activeTab);
  const setActiveTab = useRunStore((s) => s.setActiveTab);

  return (
    <nav className="flex bg-white border-b border-slate-200 px-6 shrink-0">
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          className={`px-5 py-2.5 text-sm font-medium capitalize border-b-2 transition-colors ${
            activeTab === tab
              ? "text-slate-900 border-blue-500"
              : "text-slate-500 border-transparent hover:text-slate-700"
          }`}
          onClick={() => setActiveTab(tab)}
        >
          {tab}
        </button>
      ))}
    </nav>
  );
}

/* ── Agent Config Panel (workflow tab right column) ───────────── */

function AgentConfigPanel() {
  const flowDraft = useRunStore((s) => s.flowDraft);
  const selectedAgentPath = useRunStore((s) => s.selectedAgentPath);
  const [expanded, setExpanded] = useState(true);

  const selectedAgent =
    flowDraft && selectedAgentPath.length > 0
      ? getAgentAtPath(flowDraft.orchestrator, selectedAgentPath)
      : undefined;

  return (
    <section className="flex flex-col rounded-xl border border-slate-700 bg-slate-900 overflow-hidden min-h-0 overflow-y-auto dark-scroll">
      <p className="m-0 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-blue-400 border-b border-slate-800 shrink-0">
        Agent Config
      </p>
      {selectedAgent ? (
        <AgentSummary
          agent={selectedAgent}
          path={selectedAgentPath}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          key={selectedAgentPath.join("/")}
        />
      ) : (
        <p className="m-0 px-4 py-6 text-sm text-slate-400 italic text-center">
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

  const handleDeleteFlow = useCallback(
    async (e: React.MouseEvent, fp: string) => {
      e.stopPropagation();
      if (!window.confirm(`Delete "${fp.replace("examples/", "")}"?`)) return;
      try {
        await deleteFlow(SERVER_ORIGIN, fp);
      } catch {
        // ignore
      }
    },
    [deleteFlow],
  );

  const selectedAgentName =
    selectedAgentPath.length > 0
      ? selectedAgentPath[selectedAgentPath.length - 1]
      : undefined;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] flex-1 min-h-0">
      <aside className="p-6 bg-slate-50 border-b lg:border-b-0 lg:border-r border-slate-200 overflow-y-auto">
        <p className="m-0 mb-2 text-xs font-semibold uppercase tracking-wider text-blue-600">
          Flows
        </p>
        <h1 className="m-0 text-xl font-semibold text-slate-900">Loom Studio</h1>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed">
          Pick a flow, configure the agent hierarchy, and run the orchestrator live.
        </p>
        <ul className="mt-5 list-none p-0 space-y-1.5">
          {availableFlows.length === 0 ? (
            <li className="text-sm text-slate-500">Loading flows from server...</li>
          ) : (
            availableFlows.map((candidate) => (
              <li key={candidate} className="flex">
                <button
                  type="button"
                  className={`flex-1 px-3 py-2 rounded-l-lg text-sm font-mono text-left transition-colors ${
                    candidate === flowPath
                      ? "bg-slate-900 text-white border border-transparent"
                      : "bg-white border border-slate-300 text-slate-800 hover:border-slate-400"
                  }`}
                  onClick={() => useRunStore.getState().setFlowPath(candidate)}
                >
                  {candidate.replace("examples/", "")}
                </button>
                <button
                  type="button"
                  className={`px-2.5 rounded-r-lg border border-l-0 transition-colors ${
                    candidate === flowPath
                      ? "bg-slate-800 border-transparent text-slate-400 hover:text-red-400"
                      : "bg-white border-slate-300 text-slate-400 hover:bg-red-50 hover:text-red-500"
                  }`}
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
      <main className="flex flex-col min-h-0">
        <div className="px-6 pt-5 flex items-center justify-between gap-4">
          <span className="text-lg font-semibold text-slate-900">
            {flowDraft ? flowDraft.name : "Loom Studio"}
          </span>
          <SaveControls />
        </div>
        {loadError ? (
          <p className="mx-6 mt-2 px-3 py-2 rounded-lg bg-red-50 text-red-600 text-sm">
            {loadError}
          </p>
        ) : null}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4 p-5 min-h-0">
          <div className="flex flex-col min-h-0 min-w-0">
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

/* ── Chat View ────────────────────────────────────────────────── */

function ChatView() {
  const chatRepo = useRunStore((s) => s.chatRepo);
  const setChatRepo = useRunStore((s) => s.setChatRepo);
  const availableFlows = useRunStore((s) => s.availableFlows);
  const flowPath = useRunStore((s) => s.flowPath);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] flex-1 min-h-0">
      <aside className="p-6 bg-slate-50 border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col gap-6 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <p className="m-0 text-xs font-semibold uppercase tracking-wider text-blue-600">
            Repository
          </p>
          <input
            type="text"
            className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-900 text-sm font-mono placeholder:text-slate-400 focus:outline-none focus:border-blue-400 transition-colors"
            placeholder="/path/to/repo"
            value={chatRepo}
            onChange={(e) => setChatRepo(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <p className="m-0 mb-1 text-xs font-semibold uppercase tracking-wider text-blue-600">
            Flows
          </p>
          <ul className="list-none m-0 p-0 space-y-1.5">
            {availableFlows.length === 0 ? (
              <li className="text-sm text-slate-500">No flows available</li>
            ) : (
              availableFlows.map((candidate) => (
                <li key={candidate}>
                  <button
                    type="button"
                    className={`w-full px-3 py-2 rounded-lg text-sm font-mono text-left transition-colors ${
                      candidate === flowPath
                        ? "bg-slate-900 text-white border border-transparent"
                        : "bg-white border border-slate-300 text-slate-800 hover:border-slate-400"
                    }`}
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
      <main className="flex flex-col min-h-0 p-5">
        <ChatPanel hideAgentConfig />
      </main>
    </div>
  );
}

/* ── App (root) ───────────────────────────────────────────────── */

export default function App() {
  const activeTab = useRunStore((s) => s.activeTab);
  const flowPath = useRunStore((s) => s.flowPath);
  const setAvailableFlows = useRunStore((s) => s.setAvailableFlows);
  const setLoadedFlow = useRunStore((s) => s.setLoadedFlow);
  const setLoadError = useRunStore((s) => s.setLoadError);
  const fetchRoles = useRunStore((s) => s.fetchRoles);

  useEffect(() => {
    fetchRoles(SERVER_ORIGIN);
  }, [fetchRoles]);

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
    <div className="flex flex-col min-h-screen bg-white">
      <TabBar />
      {activeTab === "workflow" && <WorkflowView />}
      {activeTab === "chat" && <ChatView />}
      {activeTab === "roles" && <RolesPanel />}
      {activeTab === "custom" && <CustomPanel />}
    </div>
  );
}
