import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "reactflow";
import { saveFlow } from "./api.js";
import { SERVER_ORIGIN } from "./sse-run.js";
import { AgentConfigForm } from "./AgentConfigForm.js";
import { NodePalette } from "./NodePalette.js";
import { agentTreeToGraph } from "./flowToGraph.js";
import {
  getAgentAtPath,
  useRunStore,
  type AgentRuntime,
  type RunHistoryItem,
} from "./store.js";
import { darkCard, inputDark, selectDark } from "./panelStyles.js";

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

function applyAgentSelection(nodes: Node[], selectedPath: string[]): Node[] {
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

export function AgentTreeCanvas() {
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

export function SaveControls() {
  const flowPath = useRunStore((s) => s.flowPath);
  const flowDraft = useRunStore((s) => s.flowDraft);
  const isDirty = useRunStore((s) => s.isDirty);
  const isSaving = useRunStore((s) => s.isSaving);
  const saveError = useRunStore((s) => s.saveError);
  const beginSave = useRunStore((s) => s.beginSave);
  const endSave = useRunStore((s) => s.endSave);
  const setSaveError = useRunStore((s) => s.setSaveError);

  const handleSave = useCallback(async () => {
    if (!flowDraft || isSaving || !isDirty) return;
    beginSave();
    try {
      await saveFlow(SERVER_ORIGIN, flowPath, flowDraft);
      endSave(flowDraft);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "save failed");
    }
  }, [beginSave, endSave, flowDraft, flowPath, isDirty, isSaving, setSaveError]);

  const canSave = Boolean(flowDraft) && !isSaving && isDirty;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-40 transition-colors"
        onClick={handleSave}
        disabled={!canSave}
      >
        {isSaving ? "Saving..." : isDirty ? "Save flow" : "Saved"}
      </button>
      {saveError ? (
        <p className="m-0 px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs">{saveError}</p>
      ) : null}
    </div>
  );
}

function FlowSettingsForm() {
  const flowDraft = useRunStore((s) => s.flowDraft);

  if (!flowDraft) {
    return (
      <p className="m-0 px-4 py-6 text-sm text-slate-400 italic text-center">
        Load a flow to edit its settings.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="m-0 rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-5 text-sm text-slate-400">
        Manage flow-level CLAUDE.md in the CLAUDE.md tab.
      </p>
    </div>
  );
}

export function AgentConfigPanel() {
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
        {selectedAgent ? "Agent Config" : "Flow Settings"}
      </p>
      {selectedAgent ? (
        <AgentConfigForm
          agent={selectedAgent}
          path={selectedAgentPath}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          key={selectedAgentPath.join("/")}
        />
      ) : (
        <FlowSettingsForm />
      )}
    </section>
  );
}

export function WorkflowTab() {
  const flowPath = useRunStore((s) => s.flowPath);
  const flowDraft = useRunStore((s) => s.flowDraft);
  const availableFlows = useRunStore((s) => s.availableFlows);
  const selectedAgentPath = useRunStore((s) => s.selectedAgentPath);
  const addAgent = useRunStore((s) => s.addAgent);
  const loadError = useRunStore((s) => s.loadError);
  const deleteFlow = useRunStore((s) => s.deleteFlow);
  const duplicateFlow = useRunStore((s) => s.duplicateFlow);

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

  const handleDuplicateFlow = useCallback(
    async (e: React.MouseEvent, sourcePath: string) => {
      e.stopPropagation();
      const baseName = sourcePath.replace(/^examples\//, "").replace(/\.ya?ml$/i, "");
      const nextName = window.prompt("Duplicate flow as", `${baseName}-copy`);
      const name = nextName?.trim();
      if (!name) return;
      try {
        await duplicateFlow(SERVER_ORIGIN, sourcePath, name);
      } catch {
        // ignore
      }
    },
    [duplicateFlow],
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
                  className={`px-2.5 border border-l-0 transition-colors ${
                    candidate === flowPath
                      ? "bg-slate-800 border-transparent text-slate-300 hover:text-blue-200"
                      : "bg-white border-slate-300 text-slate-400 hover:bg-blue-50 hover:text-blue-600"
                  }`}
                  title="Duplicate flow"
                  onClick={(e) => handleDuplicateFlow(e, candidate)}
                >
                  Copy
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

function runStatusClasses(status: RunHistoryItem["status"]): string {
  switch (status) {
    case "running":
      return "border-blue-500/40 bg-blue-500/10 text-blue-200";
    case "done":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
    default:
      return "border-red-500/40 bg-red-500/10 text-red-200";
  }
}

function runStatusDot(status: RunHistoryItem["status"]): string {
  switch (status) {
    case "running":
      return "bg-blue-400 animate-pulse";
    case "done":
      return "bg-emerald-400";
    default:
      return "bg-red-400";
  }
}

export function RunsPanel() {
  const runHistory = useRunStore((s) => s.runHistory);
  const keyword = useRunStore((s) => s.runHistoryKeyword);
  const statusFilter = useRunStore((s) => s.runHistoryStatus);
  const loading = useRunStore((s) => s.runHistoryLoading);
  const setKeyword = useRunStore((s) => s.setRunHistoryKeyword);
  const setStatus = useRunStore((s) => s.setRunHistoryStatus);
  const fetchRunHistory = useRunStore((s) => s.fetchRunHistory);

  useEffect(() => {
    fetchRunHistory(SERVER_ORIGIN);
  }, [fetchRunHistory, keyword, statusFilter]);

  useEffect(() => {
    const interval = setInterval(() => fetchRunHistory(SERVER_ORIGIN), 5000);
    return () => clearInterval(interval);
  }, [fetchRunHistory]);

  return (
    <div className="flex h-full flex-col gap-5 p-5">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
        <input
          type="text"
          placeholder="Search runs..."
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className={`w-full ${inputDark}`}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatus(e.target.value as typeof statusFilter)}
          className={selectDark}
        >
          <option value="all">All</option>
          <option value="running">Running</option>
          <option value="done">Done</option>
          <option value="error">Error</option>
        </select>
      </div>
      {loading && runHistory.length === 0 ? (
        <div className={`px-4 py-5 text-sm text-slate-400 ${darkCard}`}>Loading...</div>
      ) : runHistory.length === 0 ? (
        <div className={`px-4 py-5 text-sm text-slate-400 ${darkCard}`}>No runs found</div>
      ) : (
        <ul className="flex flex-col gap-3 overflow-y-auto">
          {runHistory.map((run: RunHistoryItem) => (
            <li key={run.runId} className={`flex items-center justify-between gap-4 px-5 py-4 ${darkCard}`}>
              <div className="min-w-0 flex flex-col gap-1">
                <span className="truncate text-sm font-semibold text-slate-100">{run.flowName}</span>
                <span className="text-xs text-slate-400">
                  {run.source === "cli" ? "CLI" : "Studio"} · {new Date(run.createdAt).toLocaleString()}
                </span>
              </div>
              <span
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${runStatusClasses(run.status)}`}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${runStatusDot(run.status)}`} />
                {run.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
