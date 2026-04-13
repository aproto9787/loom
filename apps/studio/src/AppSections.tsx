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
import { SERVER_ORIGIN, parseSseChunk, toRunStreamEvent } from "./chat-run.js";
import { AgentConfigForm, AgentTree } from "./ChatPanelSections.js";
import { NodePalette } from "./NodePalette.js";
import { agentTreeToGraph } from "./flowToGraph.js";
import {
  getAgentAtPath,
  useRunStore,
  type AgentRuntime,
} from "./store.js";

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
  const chatInput = useRunStore((s) => s.chatInput);
  const autoRunAfterSave = useRunStore((s) => s.autoRunAfterSave);
  const beginSave = useRunStore((s) => s.beginSave);
  const endSave = useRunStore((s) => s.endSave);
  const setSaveError = useRunStore((s) => s.setSaveError);
  const setActiveTab = useRunStore((s) => s.setActiveTab);
  const setAutoRunAfterSave = useRunStore((s) => s.setAutoRunAfterSave);
  const beginStream = useRunStore((s) => s.beginStream);
  const ingest = useRunStore((s) => s.ingest);
  const endStreamAction = useRunStore((s) => s.endStream);

  const runSavedFlow = useCallback(async () => {
    const prompt = chatInput.trim();
    if (!flowDraft || !prompt) return;

    setActiveTab("chat");
    beginStream();

    let response: Response;
    try {
      response = await fetch(`${SERVER_ORIGIN}/runs/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowPath, userPrompt: prompt }),
      });
    } catch (error) {
      ingest({
        kind: "run_error",
        message: error instanceof Error ? error.message : String(error),
      });
      endStreamAction();
      return;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      ingest({
        kind: "run_error",
        message: `HTTP ${response.status}${text ? `: ${text}` : ""}`,
      });
      endStreamAction();
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
      endStreamAction();
      setAutoRunAfterSave(false);
    }
  }, [beginStream, chatInput, endStreamAction, flowDraft, flowPath, ingest, setActiveTab, setAutoRunAfterSave]);

  const handleSave = useCallback(async () => {
    if (!flowDraft || isSaving || (!isDirty && !autoRunAfterSave)) return;
    beginSave();
    try {
      await saveFlow(SERVER_ORIGIN, flowPath, flowDraft);
      endSave(flowDraft);
      if (autoRunAfterSave) {
        await runSavedFlow();
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "save failed");
      setAutoRunAfterSave(false);
    }
  }, [autoRunAfterSave, beginSave, endSave, flowDraft, flowPath, isDirty, isSaving, runSavedFlow, setAutoRunAfterSave, setSaveError]);

  const handleSaveAndRunToggle = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setAutoRunAfterSave(event.target.checked);
  }, [setAutoRunAfterSave]);

  const canSave = Boolean(flowDraft) && !isSaving && (isDirty || autoRunAfterSave);
  const canSaveAndRun = Boolean(flowDraft) && !isSaving && chatInput.trim().length > 0;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-40 transition-colors"
        onClick={handleSave}
        disabled={!canSave}
      >
        {isSaving ? "Saving..." : isDirty ? "Save flow" : autoRunAfterSave ? "Save & run" : "Saved"}
      </button>
      <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${canSaveAndRun ? "border-blue-200 bg-blue-50 text-blue-700" : "border-slate-200 bg-slate-50 text-slate-400"}`}>
        <input
          type="checkbox"
          className="h-3.5 w-3.5"
          checked={autoRunAfterSave}
          onChange={handleSaveAndRunToggle}
          disabled={!canSaveAndRun}
        />
        Save then run from Chat prompt
      </label>
      {saveError ? (
        <p className="m-0 px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs">{saveError}</p>
      ) : null}
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
        Agent Config
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
        <p className="m-0 px-4 py-6 text-sm text-slate-400 italic text-center">
          Select an agent in the tree to edit its configuration.
        </p>
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

export function HistoryTab() {
  const chatRepo = useRunStore((s) => s.chatRepo);
  const setChatRepo = useRunStore((s) => s.setChatRepo);
  const availableFlows = useRunStore((s) => s.availableFlows);
  const flowPath = useRunStore((s) => s.flowPath);
  const runHistory = useRunStore((s) => s.runHistory);
  const runHistoryKeyword = useRunStore((s) => s.runHistoryKeyword);
  const runHistoryStatus = useRunStore((s) => s.runHistoryStatus);
  const runHistoryLoading = useRunStore((s) => s.runHistoryLoading);
  const setRunHistoryKeyword = useRunStore((s) => s.setRunHistoryKeyword);
  const setRunHistoryStatus = useRunStore((s) => s.setRunHistoryStatus);
  const fetchRunHistory = useRunStore((s) => s.fetchRunHistory);

  useEffect(() => {
    fetchRunHistory(SERVER_ORIGIN);
  }, [fetchRunHistory, runHistoryKeyword, runHistoryStatus]);

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
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="m-0 text-xs font-semibold uppercase tracking-wider text-blue-600">
                Run History
              </p>
              <p className="m-0 mt-1 text-xs text-slate-500">
                Search prior executions from the API.
              </p>
            </div>
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
              onClick={() => fetchRunHistory(SERVER_ORIGIN)}
              disabled={runHistoryLoading}
            >
              {runHistoryLoading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          <input
            type="search"
            className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-900 text-sm placeholder:text-slate-400 focus:outline-none focus:border-blue-400 transition-colors"
            placeholder="Search flow or run id"
            value={runHistoryKeyword}
            onChange={(e) => setRunHistoryKeyword(e.target.value)}
          />
          <select
            className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-900 text-sm focus:outline-none focus:border-blue-400 transition-colors"
            value={runHistoryStatus}
            onChange={(e) => setRunHistoryStatus(e.target.value as "all" | "success" | "failed" | "aborted")}
          >
            <option value="all">All statuses</option>
            <option value="success">success</option>
            <option value="failed">failed</option>
            <option value="aborted">aborted</option>
          </select>
          <div className="max-h-[320px] overflow-y-auto pr-1">
            {runHistory.length === 0 ? (
              <p className="m-0 rounded-lg border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-500">
                {runHistoryLoading ? "Loading run history..." : "No runs matched the current filters."}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {runHistory.map((item) => (
                  <li key={item.runId} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{item.flowName}</span>
                      <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                        {item.status}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-xs text-slate-500">Run ID: {item.runId}</div>
                    <div className="mt-1 text-xs text-slate-500">Created: {new Date(item.createdAt).toLocaleString()}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </aside>
      <main className="flex flex-col min-h-0 p-5">
        <AgentTree hideAgentConfig />
      </main>
    </div>
  );
}
