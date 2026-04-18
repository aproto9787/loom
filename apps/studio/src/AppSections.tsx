import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type RunDetailEvent,
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

  const createFlow = useRunStore((s) => s.createFlow);
  const handleCreateFlow = useCallback(async () => {
    const entered = window.prompt("New flow name");
    const name = entered?.trim();
    if (!name) return;
    try {
      await createFlow(SERVER_ORIGIN, name);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to create flow");
    }
  }, [createFlow]);

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
        <button
          type="button"
          className="mt-3 w-full px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors"
          onClick={handleCreateFlow}
        >
          + New flow
        </button>
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
    case "success":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
    case "stale":
      return "border-amber-500/40 bg-amber-500/10 text-amber-200";
    case "aborted":
      return "border-slate-500/40 bg-slate-500/10 text-slate-200";
    default:
      return "border-red-500/40 bg-red-500/10 text-red-200";
  }
}

function runStatusDot(status: RunHistoryItem["status"]): string {
  switch (status) {
    case "running":
      return "bg-blue-400 animate-pulse";
    case "done":
    case "success":
      return "bg-emerald-400";
    case "stale":
      return "bg-amber-400";
    case "aborted":
      return "bg-slate-400";
    default:
      return "bg-red-400";
  }
}

function formatElapsed(run: RunHistoryItem, now: number): string {
  const start = run.startedAt ? Date.parse(run.startedAt) : Date.parse(run.createdAt);
  if (!Number.isFinite(start)) return "";
  const endRef = run.endedAt ? Date.parse(run.endedAt) : now;
  const elapsed = Math.max(0, Math.floor(((Number.isFinite(endRef) ? endRef : now) - start) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const mins = Math.floor(elapsed / 60);
  if (mins < 60) return `${mins}m ${elapsed % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function shortenPath(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const segments = value.split("/").filter(Boolean);
  if (segments.length <= 2) return value;
  return `…/${segments.slice(-2).join("/")}`;
}

function agentTypeLabel(value?: string): string {
  if (value === "claude-code") return "claude";
  if (value === "codex") return "codex";
  return value ?? "";
}

function eventTypeBadge(type: RunDetailEvent["type"]): string {
  switch (type) {
    case "tool_use":
      return "bg-indigo-500/10 text-indigo-200 border-indigo-500/40";
    case "tool_result":
      return "bg-teal-500/10 text-teal-200 border-teal-500/40";
    case "assistant":
      return "bg-violet-500/10 text-violet-200 border-violet-500/40";
    case "user":
      return "bg-slate-500/10 text-slate-200 border-slate-500/40";
    case "error":
      return "bg-red-500/10 text-red-200 border-red-500/40";
    default:
      return "bg-slate-500/10 text-slate-200 border-slate-500/40";
  }
}

function formatEventClock(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatAgentLabel(agentName: string | undefined, agentKind: string | undefined): string | undefined {
  if (!agentName) return undefined;
  const kindSuffix = agentKind ? ` (${agentKind})` : "";
  if (UUID_RE.test(agentName)) {
    return `${agentName.slice(0, 8)}${kindSuffix}`;
  }
  return `${agentName}${kindSuffix}`;
}

function agentLabelColor(agentKind: string | undefined): string {
  switch (agentKind) {
    case "codex":
      return "text-amber-400/80";
    case "claude":
      return "text-sky-400/80";
    default:
      return "text-slate-500";
  }
}

interface AgentNode {
  name: string;
  kind?: string;
  parentAgent?: string;
  depth: number;
  firstTs: number;
  lastTs: number;
  eventCount: number;
  state: "running" | "done" | "error";
}

function buildAgentTree(events: RunDetailEvent[], runStatus: string | undefined): AgentNode[] {
  const map = new Map<string, AgentNode>();
  for (const ev of events) {
    const name = ev.agentName;
    if (!name) continue;
    let node = map.get(name);
    if (!node) {
      node = {
        name,
        kind: ev.agentKind,
        parentAgent: ev.parentAgent,
        depth: 0,
        firstTs: ev.ts,
        lastTs: ev.ts,
        eventCount: 0,
        state: "running",
      };
      map.set(name, node);
    }
    node.lastTs = Math.max(node.lastTs, ev.ts);
    node.eventCount += 1;
    if (ev.agentKind && !node.kind) node.kind = ev.agentKind;
    if (ev.parentAgent && !node.parentAgent) node.parentAgent = ev.parentAgent;
    if (ev.type === "error") node.state = "error";
    if (typeof ev.summary === "string" && /\bstatus:\s*done\b/i.test(ev.summary)) node.state = "done";
  }
  const runIsLive = runStatus === "running";
  for (const n of map.values()) {
    if (!runIsLive && n.state === "running") n.state = "done";
  }
  const byName = new Map(Array.from(map.values()).map((n) => [n.name, n]));
  const depthOf = (name: string, seen = new Set<string>()): number => {
    const node = byName.get(name);
    if (!node || !node.parentAgent) return 0;
    if (seen.has(name)) return 0;
    seen.add(name);
    return 1 + depthOf(node.parentAgent, seen);
  };
  for (const n of map.values()) n.depth = depthOf(n.name);
  return Array.from(map.values()).sort((a, b) => a.firstTs - b.firstTs);
}

function agentStateDot(state: AgentNode["state"]): string {
  switch (state) {
    case "running":
      return "bg-emerald-400 animate-pulse";
    case "error":
      return "bg-red-400";
    default:
      return "bg-slate-500";
  }
}

export function RunsPanel() {
  const runHistory = useRunStore((s) => s.runHistory);
  const keyword = useRunStore((s) => s.runHistoryKeyword);
  const statusFilter = useRunStore((s) => s.runHistoryStatus);
  const loading = useRunStore((s) => s.runHistoryLoading);
  const selectedRunId = useRunStore((s) => s.selectedRunId);
  const selectedAgent = useRunStore((s) => s.selectedAgent);
  const runDetailEvents = useRunStore((s) => s.runDetailEvents);
  const runDetailLoading = useRunStore((s) => s.runDetailLoading);
  const runDetailStreamOpen = useRunStore((s) => s.runDetailStreamOpen);
  const setKeyword = useRunStore((s) => s.setRunHistoryKeyword);
  const setStatus = useRunStore((s) => s.setRunHistoryStatus);
  const fetchRunHistory = useRunStore((s) => s.fetchRunHistory);
  const selectRun = useRunStore((s) => s.selectRun);
  const selectRunAgent = useRunStore((s) => s.selectRunAgent);
  const closeRunDetailStream = useRunStore((s) => s.closeRunDetailStream);

  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchRunHistory(SERVER_ORIGIN);
  }, [fetchRunHistory, keyword, statusFilter]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchRunHistory(SERVER_ORIGIN);
      setNowTick(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [fetchRunHistory]);

  useEffect(() => {
    return () => {
      closeRunDetailStream();
    };
  }, [closeRunDetailStream]);

  const selectedRun = useMemo(
    () => runHistory.find((run) => run.runId === selectedRunId),
    [runHistory, selectedRunId],
  );

  const agentTree = useMemo(
    () => buildAgentTree(runDetailEvents, selectedRun?.status),
    [runDetailEvents, selectedRun?.status],
  );

  const selectedAgentNode = useMemo(
    () => (selectedAgent ? agentTree.find((n) => n.name === selectedAgent) : undefined),
    [agentTree, selectedAgent],
  );

  const filteredEvents = useMemo(
    () => (selectedAgent ? runDetailEvents.filter((e) => e.agentName === selectedAgent) : runDetailEvents),
    [runDetailEvents, selectedAgent],
  );

  // Jump to the bottom unconditionally when the user switches run or
  // agent filter — behave like a chat view where "latest is always in
  // view" on open. requestAnimationFrame ensures the newly rendered
  // list has laid out before we measure scrollHeight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handle = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(handle);
  }, [selectedRunId, selectedAgent]);

  // As new events stream in, follow the tail only when the user is
  // already near the bottom. If they scrolled up to read history, let
  // them stay put.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    if (distanceFromBottom < 180) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredEvents.length]);

  const handleSelect = useCallback((runId: string) => {
    if (selectedRunId === runId) return;
    selectRun(SERVER_ORIGIN, runId);
  }, [selectedRunId, selectRun]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_140px]">
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
          <option value="stale">Stale</option>
          <option value="aborted">Aborted</option>
        </select>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[240px_260px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col overflow-y-auto pr-1">
          {loading && runHistory.length === 0 ? (
            <div className="px-3 py-4 text-xs text-slate-500">Loading…</div>
          ) : runHistory.length === 0 ? (
            <div className="px-3 py-4 text-xs text-slate-500">No runs</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {runHistory.map((run: RunHistoryItem) => {
                const isSelected = run.runId === selectedRunId;
                return (
                  <li key={run.runId}>
                    <button
                      type="button"
                      onClick={() => handleSelect(run.runId)}
                      className={`w-full text-left px-2.5 py-2 rounded-md border text-[12px] transition ${
                        isSelected
                          ? "border-blue-400/60 bg-blue-500/10 text-slate-100"
                          : "border-slate-800 bg-slate-900/30 text-slate-300 hover:border-slate-600 hover:bg-slate-800/40"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${runStatusDot(run.status)}`} />
                        <span className="truncate flex-1 font-medium">{run.flowName}</span>
                        <span className="text-[10px] text-slate-500 shrink-0">{formatElapsed(run, nowTick)}</span>
                      </div>
                      <div className="truncate text-[10px] text-slate-500 mt-0.5 pl-3.5">
                        {shortenPath(run.cwd ?? undefined) ?? "—"}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className={`flex min-h-0 flex-col overflow-hidden ${darkCard}`}>
          <div className="border-b border-slate-800 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">
            Agents {agentTree.length > 0 ? `· ${agentTree.length}` : ""}
          </div>
          {!selectedRun ? (
            <div className="p-3 text-xs text-slate-500">Select a run</div>
          ) : agentTree.length === 0 ? (
            <div className="p-3 text-xs text-slate-500">No agents yet</div>
          ) : (
            <ul className="flex-1 overflow-y-auto px-1.5 py-1.5">
              <li>
                <button
                  type="button"
                  onClick={() => selectRunAgent(undefined)}
                  className={`w-full text-left px-2 py-1.5 rounded-md text-[12px] transition flex items-center gap-2 ${
                    !selectedAgent ? "bg-blue-500/20 text-slate-100" : "text-slate-300 hover:bg-slate-800/50"
                  }`}
                >
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">all</span>
                  <span className="ml-auto text-[10px] text-slate-500">{runDetailEvents.length}</span>
                </button>
              </li>
              {agentTree.map((node) => {
                const isSel = node.name === selectedAgent;
                const indent = Math.min(node.depth, 4) * 12;
                return (
                  <li key={node.name}>
                    <button
                      type="button"
                      onClick={() => selectRunAgent(isSel ? undefined : node.name)}
                      style={{ paddingLeft: 8 + indent }}
                      className={`w-full text-left pr-2 py-1.5 rounded-md text-[12px] transition flex items-center gap-2 ${
                        isSel ? "bg-blue-500/20 text-slate-100" : "text-slate-300 hover:bg-slate-800/50"
                      }`}
                    >
                      <span className={`h-2 w-2 rounded-full shrink-0 ${agentStateDot(node.state)}`} />
                      <span className={`truncate font-mono ${agentLabelColor(node.kind)}`}>
                        {formatAgentLabel(node.name, node.kind) ?? node.name}
                      </span>
                      <span className="ml-auto text-[10px] text-slate-500 shrink-0">{node.eventCount}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className={`flex min-h-0 flex-col overflow-hidden ${darkCard}`}>
          {!selectedRun ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-slate-500">
              Select a run to see its activity
            </div>
          ) : (
            <>
              <div className="border-b border-slate-800 px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold text-slate-100">
                      {selectedAgentNode
                        ? (formatAgentLabel(selectedAgentNode.name, selectedAgentNode.kind) ?? selectedAgentNode.name)
                        : `${selectedRun.flowName} · all agents`}
                    </span>
                    <span className="truncate text-[11px] text-slate-400">
                      {selectedAgentNode
                        ? `${selectedAgentNode.eventCount} events · ${selectedAgentNode.state}${selectedAgentNode.parentAgent ? ` · ← ${selectedAgentNode.parentAgent}` : ""}`
                        : (selectedRun.cwd ?? "(no cwd)")}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {selectedAgent ? (
                      <button
                        type="button"
                        onClick={() => selectRunAgent(undefined)}
                        className="text-[11px] text-slate-400 hover:text-slate-100 underline"
                      >
                        show all
                      </button>
                    ) : null}
                    <span
                      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${runStatusClasses(selectedRun.status)}`}
                    >
                      <span className={`h-2 w-2 rounded-full ${runStatusDot(selectedRun.status)}`} />
                      {selectedRun.status}
                    </span>
                    <span className="text-[11px] text-slate-400">elapsed {formatElapsed(selectedRun, nowTick)}</span>
                    {runDetailStreamOpen ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                        <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> live
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {runDetailLoading && filteredEvents.length === 0 ? (
                  <div className="text-xs text-slate-500">Loading events…</div>
                ) : filteredEvents.length === 0 ? (
                  <div className="text-xs text-slate-500">
                    {selectedAgent ? `No events from ${selectedAgent} yet` : "No events recorded yet."}
                  </div>
                ) : (
                  <ul className="flex flex-col gap-2.5">
                    {filteredEvents.map((event, index) => {
                      const agentLabel = formatAgentLabel(event.agentName, event.agentKind);
                      return (
                        <li key={`${event.ts}-${index}`} className="flex items-start gap-3 py-1">
                          <span className="w-16 shrink-0 text-[10px] font-mono text-slate-500">{formatEventClock(event.ts)}</span>
                          <span className={`shrink-0 rounded border px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wide ${eventTypeBadge(event.type)}`}>
                            {event.type}
                          </span>
                          <div className="min-w-0 flex flex-col gap-0.5 text-[13px] leading-relaxed">
                            {event.toolName ? (
                              <span className="font-mono text-slate-200">{event.toolName}</span>
                            ) : null}
                            {event.summary ? (
                              <span className="text-slate-200 whitespace-pre-wrap break-words">{event.summary}</span>
                            ) : null}
                            {!selectedAgent && agentLabel ? (
                              <span className={`text-[10px] ${agentLabelColor(event.agentKind)}`}>
                                {agentLabel}
                                {event.parentAgent ? (
                                  <span className="text-slate-600"> ← {formatAgentLabel(event.parentAgent, undefined) ?? event.parentAgent}</span>
                                ) : null}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
