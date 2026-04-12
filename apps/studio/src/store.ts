import { create } from "zustand";
import type { FlowNode, LoomFlow } from "@loom/core";

export type RunStreamEvent =
  | { kind: "run_start"; runId: string; flowName: string }
  | { kind: "node_start"; nodeId: string; type: string }
  | { kind: "node_token"; nodeId: string; text: string }
  | {
      kind: "node_complete";
      nodeId: string;
      output: unknown;
      meta?: Record<string, unknown>;
    }
  | { kind: "node_skipped"; nodeId: string }
  | { kind: "node_error"; nodeId: string; message: string }
  | {
      kind: "run_complete";
      runId: string;
      flowName: string;
      outputs: Record<string, unknown>;
      nodeResults: PersistedNodeResult[];
    }
  | { kind: "run_error"; runId?: string; message: string };

export type NodeRunState = "pending" | "running" | "done" | "skipped" | "error";

export interface NodeRuntime {
  id: string;
  type?: string;
  state: NodeRunState;
  tokens: string[];
  output?: unknown;
  meta?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface PersistedNodeResult {
  nodeId: string;
  output: unknown;
  startedAt?: string;
  finishedAt?: string;
}

export interface PersistedRunSummary {
  runId: string;
  flowName: string;
  flowPath: string;
  requestedInputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  createdAt: string;
  nodeResults: PersistedNodeResult[];
}

export type EditableNodeType = FlowNode["type"];

function cloneFlow(flow: LoomFlow): LoomFlow {
  return JSON.parse(JSON.stringify(flow)) as LoomFlow;
}

function nextNodeId(existing: FlowNode[], type: EditableNodeType): string {
  const base = type.split(".")[1] ?? type;
  let counter = 1;
  while (existing.some((node) => node.id === `${base}_${counter}`)) {
    counter += 1;
  }
  return `${base}_${counter}`;
}

function defaultConfigFor(type: EditableNodeType): Record<string, unknown> {
  switch (type) {
    case "io.input":
      return {};
    case "io.output":
      return {};
    case "io.file":
      return { path: "./outputs/file.txt", mode: "write" };
    case "router.code":
      return { expression: "'default'" };
    case "agent.claude":
      return { model: "claude-opus-4-6", system: "" };
    case "agent.litellm":
      return { model: "gpt-4o-mini", system: "" };
    case "agent.claude-code":
      return { model: "claude-opus-4-6", system: "" };
    case "agent.codex":
      return { model: "o4-mini", system: "" };
    case "router.llm":
      return { model: "claude-sonnet-4-6", system: "" };
    case "control.loop":
      return { mode: "for-each", max: 10 };
    case "control.parallel":
      return {};
    case "control.join":
      return { mode: "all" };
    case "memory.memento":
      return { operation: "recall" };
    case "mcp.server":
      return { command: "node", args: [] };
    default:
      return {};
  }
}

function emptyNode(id: string): NodeRuntime {
  return { id, state: "pending", tokens: [] };
}

function durationBetween(startedAt?: string, finishedAt?: string): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(finishedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return undefined;
  return Math.max(endMs - startMs, 0);
}

function hydrateReplayNodes(nodeResults: PersistedNodeResult[]): Record<string, NodeRuntime> {
  const replayNodes: Record<string, NodeRuntime> = {};
  for (const node of nodeResults) {
    replayNodes[node.nodeId] = {
      id: node.nodeId,
      state: "done",
      tokens: [],
      output: node.output,
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      durationMs: durationBetween(node.startedAt, node.finishedAt),
    };
  }
  return replayNodes;
}

function createFlowNode(type: EditableNodeType, existing: FlowNode[]): FlowNode {
  return {
    id: nextNodeId(existing, type),
    type,
    config: defaultConfigFor(type),
    mcps: [],
    inputs: {},
    outputs: {},
    branches: [],
  };
}

function nextInputName(existing: FlowNode["inputs"], sourceId: string): string {
  const preferred = `from_${sourceId}`;
  if (!(preferred in existing)) {
    return preferred;
  }
  let counter = 2;
  while (`${preferred}_${counter}` in existing) {
    counter += 1;
  }
  return `${preferred}_${counter}`;
}

function flowsAreEqual(a: LoomFlow | undefined, b: LoomFlow | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface Position {
  x: number;
  y: number;
}

interface RunState {
  flowPath: string;
  inputsJson: string;
  availableFlows: string[];
  loadedFlow?: LoomFlow;
  flowDraft?: LoomFlow;
  isDirty: boolean;
  selectedNodeId?: string;
  selectedInspectorRunNodeId?: string;
  replaySelectedNodeId?: string;
  isSaving: boolean;
  saveError?: string;
  nodePositionOverrides: Record<string, Position>;
  isStreaming: boolean;
  runId?: string;
  flowName?: string;
  events: RunStreamEvent[];
  nodeRuntimes: Record<string, NodeRuntime>;
  finalOutputs?: Record<string, unknown>;
  runError?: string;
  loadError?: string;
  runHistory: PersistedRunSummary[];
  selectedRunId?: string;
  setFlowPath: (value: string) => void;
  setInputsJson: (value: string) => void;
  setAvailableFlows: (flows: string[]) => void;
  setLoadedFlow: (flow: LoomFlow | undefined) => void;
  setLoadError: (message: string | undefined) => void;
  setRunHistory: (runs: PersistedRunSummary[]) => void;
  selectRun: (runId: string | undefined) => void;
  selectNode: (nodeId: string | undefined) => void;
  addNode: (type: EditableNodeType, position?: Position) => void;
  deleteNode: (nodeId: string) => void;
  updateNode: (nodeId: string, patch: Partial<FlowNode>) => void;
  renameNode: (oldId: string, newId: string) => void;
  connectNodes: (sourceId: string, targetId: string) => void;
  disconnectEdge: (sourceId: string, targetId: string) => void;
  setNodePosition: (nodeId: string, position: Position) => void;
  beginSave: () => void;
  endSave: (savedFlow: LoomFlow) => void;
  setSaveError: (message: string | undefined) => void;
  selectReplayNode: (nodeId: string | undefined) => void;
  beginStream: () => void;
  ingest: (event: RunStreamEvent) => void;
  endStream: () => void;
}

export const useRunStore = create<RunState>((set) => ({
  flowPath: "examples/hello.yaml",
  inputsJson: '{\n  "topic": "loom studio"\n}',
  availableFlows: [],
  isDirty: false,
  runHistory: [],
  isSaving: false,
  nodePositionOverrides: {},
  isStreaming: false,
  events: [],
  nodeRuntimes: {},
  setFlowPath: (value) =>
    set({
      flowPath: value,
      flowDraft: undefined,
      isDirty: false,
      selectedNodeId: undefined,
      selectedInspectorRunNodeId: undefined,
      replaySelectedNodeId: undefined,
      saveError: undefined,
      nodePositionOverrides: {},
    }),
  setInputsJson: (value) => set({ inputsJson: value }),
  setAvailableFlows: (flows) => set({ availableFlows: flows }),
  setRunHistory: (runs) =>
    set((state) => {
      const fallbackSelectedRunId = state.selectedRunId && runs.some((run) => run.runId === state.selectedRunId)
        ? state.selectedRunId
        : runs[0]?.runId;
      const selectedRun = runs.find((run) => run.runId === fallbackSelectedRunId);
      return {
        runHistory: runs,
        selectedRunId: fallbackSelectedRunId,
        replaySelectedNodeId: undefined,
        selectedInspectorRunNodeId: undefined,
        nodeRuntimes:
          !state.isStreaming && selectedRun
            ? hydrateReplayNodes(selectedRun.nodeResults)
            : state.nodeRuntimes,
        finalOutputs: !state.isStreaming && selectedRun ? selectedRun.outputs : state.finalOutputs,
        runId: !state.isStreaming && selectedRun ? selectedRun.runId : state.runId,
        flowName: !state.isStreaming && selectedRun ? selectedRun.flowName : state.flowName,
        inputsJson:
          !state.isStreaming && selectedRun
            ? JSON.stringify(selectedRun.requestedInputs, null, 2)
            : state.inputsJson,
      };
    }),
  selectRun: (runId) =>
    set((state) => {
      const selectedRun = state.runHistory.find((run) => run.runId === runId);
      if (!selectedRun) {
        return {
          selectedRunId: runId,
          replaySelectedNodeId: undefined,
          selectedInspectorRunNodeId: undefined,
        };
      }
      return {
        selectedRunId: selectedRun.runId,
        replaySelectedNodeId: undefined,
        selectedInspectorRunNodeId: undefined,
        nodeRuntimes: state.isStreaming ? state.nodeRuntimes : hydrateReplayNodes(selectedRun.nodeResults),
        finalOutputs: state.isStreaming ? state.finalOutputs : selectedRun.outputs,
        runId: state.isStreaming ? state.runId : selectedRun.runId,
        flowName: state.isStreaming ? state.flowName : selectedRun.flowName,
        inputsJson: state.isStreaming
          ? state.inputsJson
          : JSON.stringify(selectedRun.requestedInputs, null, 2),
      };
    }),
  setLoadedFlow: (flow) =>
    set({
      loadedFlow: flow,
      flowDraft: flow ? cloneFlow(flow) : undefined,
      isDirty: false,
      selectedNodeId: undefined,
      selectedInspectorRunNodeId: undefined,
      replaySelectedNodeId: undefined,
      saveError: undefined,
      nodePositionOverrides: {},
      loadError: undefined,
    }),
  setLoadError: (message) => set({ loadError: message }),
  selectNode: (nodeId) =>
    set({
      selectedNodeId: nodeId,
      selectedInspectorRunNodeId: nodeId,
      replaySelectedNodeId: nodeId,
    }),
  addNode: (type, position) =>
    set((state) => {
      if (!state.flowDraft) return state;
      const draft = cloneFlow(state.flowDraft);
      const node = createFlowNode(type, draft.nodes);
      draft.nodes.push(node);
      const nextOverrides = { ...state.nodePositionOverrides };
      if (position) {
        nextOverrides[node.id] = position;
      }
      return {
        flowDraft: draft,
        isDirty: !flowsAreEqual(draft, state.loadedFlow),
        selectedNodeId: node.id,
        nodePositionOverrides: nextOverrides,
      };
    }),
  deleteNode: (nodeId) =>
    set((state) => {
      if (!state.flowDraft) return state;
      const draft = cloneFlow(state.flowDraft);
      draft.nodes = draft.nodes.filter((node) => node.id !== nodeId);
      for (const node of draft.nodes) {
        const nextInputs: FlowNode["inputs"] = {};
        for (const [key, ref] of Object.entries(node.inputs)) {
          const refHead = ref.from.split(".")[0];
          if (refHead !== nodeId) nextInputs[key] = ref;
        }
        node.inputs = nextInputs;
        if (node.when) {
          const whenHead = node.when.split(/\s*==\s*/)[0]?.split(".")[0];
          if (whenHead === nodeId) {
            delete node.when;
          }
        }
      }
      draft.outputs = draft.outputs.filter((out) => out.from.split(".")[0] !== nodeId);
      const nextOverrides = { ...state.nodePositionOverrides };
      delete nextOverrides[nodeId];
      return {
        flowDraft: draft,
        isDirty: !flowsAreEqual(draft, state.loadedFlow),
        selectedNodeId: state.selectedNodeId === nodeId ? undefined : state.selectedNodeId,
        nodePositionOverrides: nextOverrides,
      };
    }),
  updateNode: (nodeId, patch) =>
    set((state) => {
      if (!state.flowDraft) return state;
      const draft = cloneFlow(state.flowDraft);
      const target = draft.nodes.find((node) => node.id === nodeId);
      if (!target) return state;
      Object.assign(target, patch);
      return {
        flowDraft: draft,
        isDirty: !flowsAreEqual(draft, state.loadedFlow),
      };
    }),
  renameNode: (oldId, newId) =>
    set((state) => {
      if (!state.flowDraft) return state;
      if (oldId === newId) return state;
      if (!newId.trim()) return state;
      const draft = cloneFlow(state.flowDraft);
      if (draft.nodes.some((node) => node.id === newId)) {
        return { saveError: `node id "${newId}" already in use` };
      }
      const target = draft.nodes.find((node) => node.id === oldId);
      if (!target) return state;
      target.id = newId;
      // Rewrite every other node's references to oldId.
      for (const node of draft.nodes) {
        if (node.id === newId) continue;
        for (const ref of Object.values(node.inputs)) {
          const parts = ref.from.split(".");
          if (parts[0] === oldId) {
            parts[0] = newId;
            ref.from = parts.join(".");
          }
        }
        if (node.when) {
          const [lhs, rhs] = node.when.split(/\s*==\s*/);
          const lhsParts = lhs?.split(".") ?? [];
          if (lhsParts[0] === oldId) {
            lhsParts[0] = newId;
            node.when = [lhsParts.join("."), rhs].filter(Boolean).join(" == ");
          }
        }
      }
      for (const out of draft.outputs) {
        const parts = out.from.split(".");
        if (parts[0] === oldId) {
          parts[0] = newId;
          out.from = parts.join(".");
        }
      }
      const nextOverrides = { ...state.nodePositionOverrides };
      if (nextOverrides[oldId]) {
        nextOverrides[newId] = nextOverrides[oldId];
        delete nextOverrides[oldId];
      }
      return {
        flowDraft: draft,
        isDirty: !flowsAreEqual(draft, state.loadedFlow),
        selectedNodeId: state.selectedNodeId === oldId ? newId : state.selectedNodeId,
        nodePositionOverrides: nextOverrides,
        saveError: undefined,
      };
    }),
  connectNodes: (sourceId, targetId) =>
    set((state) => {
      if (!state.flowDraft) return state;
      if (sourceId === targetId) return state;
      const draft = cloneFlow(state.flowDraft);
      const target = draft.nodes.find((node) => node.id === targetId);
      if (!target) return state;
      const alreadyWired = Object.values(target.inputs).some(
        (ref) => ref.from === sourceId || ref.from.startsWith(`${sourceId}.`),
      );
      if (alreadyWired) return state;
      const inputName = nextInputName(target.inputs, sourceId);
      target.inputs[inputName] = { from: sourceId };
      return {
        flowDraft: draft,
        isDirty: !flowsAreEqual(draft, state.loadedFlow),
      };
    }),
  disconnectEdge: (sourceId, targetId) =>
    set((state) => {
      if (!state.flowDraft) return state;
      const draft = cloneFlow(state.flowDraft);
      const target = draft.nodes.find((node) => node.id === targetId);
      if (!target) return state;
      const nextInputs: FlowNode["inputs"] = {};
      for (const [key, ref] of Object.entries(target.inputs)) {
        const refHead = ref.from.split(".")[0];
        if (refHead !== sourceId) nextInputs[key] = ref;
      }
      target.inputs = nextInputs;
      return {
        flowDraft: draft,
        isDirty: !flowsAreEqual(draft, state.loadedFlow),
      };
    }),
  setNodePosition: (nodeId, position) =>
    set((state) => ({
      nodePositionOverrides: {
        ...state.nodePositionOverrides,
        [nodeId]: position,
      },
    })),
  beginSave: () => set({ isSaving: true, saveError: undefined }),
  selectReplayNode: (nodeId) =>
    set((state) => {
      const selected = nodeId ?? undefined;
      const draftHasNode = selected
        ? Boolean(state.flowDraft?.nodes.some((node) => node.id === selected))
        : false;
      return {
        replaySelectedNodeId: selected,
        selectedInspectorRunNodeId: selected,
        selectedNodeId: draftHasNode ? selected : state.selectedNodeId,
      };
    }),
  endSave: (savedFlow) =>
    set({
      isSaving: false,
      loadedFlow: savedFlow,
      flowDraft: cloneFlow(savedFlow),
      isDirty: false,
      saveError: undefined,
    }),
  setSaveError: (message) => set({ isSaving: false, saveError: message }),
  beginStream: () =>
    set({
      isStreaming: true,
      events: [],
      nodeRuntimes: {},
      finalOutputs: undefined,
      runError: undefined,
      runId: undefined,
      flowName: undefined,
      replaySelectedNodeId: undefined,
      selectedInspectorRunNodeId: undefined,
    }),
  endStream: () => set({ isStreaming: false }),
  ingest: (event) =>
    set((state) => {
      const nextEvents = [...state.events, event];
      const nextNodes: Record<string, NodeRuntime> = { ...state.nodeRuntimes };
      let nextRunId = state.runId;
      let nextFlowName = state.flowName;
      let nextOutputs = state.finalOutputs;
      let nextRunError = state.runError;

      switch (event.kind) {
        case "run_start":
          nextRunId = event.runId;
          nextFlowName = event.flowName;
          break;
        case "node_start": {
          const current = nextNodes[event.nodeId] ?? emptyNode(event.nodeId);
          nextNodes[event.nodeId] = {
            ...current,
            state: "running",
            type: event.type,
            startedAt: current.startedAt ?? new Date().toISOString(),
            finishedAt: undefined,
            durationMs: undefined,
            error: undefined,
          };
          break;
        }
        case "node_token": {
          const current = nextNodes[event.nodeId] ?? emptyNode(event.nodeId);
          nextNodes[event.nodeId] = {
            ...current,
            tokens: [...current.tokens, event.text],
          };
          break;
        }
        case "node_complete": {
          const current = nextNodes[event.nodeId] ?? emptyNode(event.nodeId);
          const finishedAt = new Date().toISOString();
          nextNodes[event.nodeId] = {
            ...current,
            state: "done",
            output: event.output,
            meta: event.meta ?? current.meta,
            startedAt: current.startedAt,
            finishedAt,
            durationMs: durationBetween(current.startedAt, finishedAt),
            error: undefined,
          };
          break;
        }
        case "node_skipped": {
          const current = nextNodes[event.nodeId] ?? emptyNode(event.nodeId);
          const finishedAt = new Date().toISOString();
          nextNodes[event.nodeId] = {
            ...current,
            state: "skipped",
            finishedAt,
            durationMs: durationBetween(current.startedAt, finishedAt),
          };
          break;
        }
        case "node_error": {
          const current = nextNodes[event.nodeId] ?? emptyNode(event.nodeId);
          const finishedAt = new Date().toISOString();
          nextNodes[event.nodeId] = {
            ...current,
            state: "error",
            error: event.message,
            finishedAt,
            durationMs: durationBetween(current.startedAt, finishedAt),
          };
          break;
        }
        case "run_complete":
          nextOutputs = event.outputs;
          break;
        case "run_error":
          nextRunError = event.message;
          break;
        default:
          break;
      }

      return {
        events: nextEvents,
        nodeRuntimes: nextNodes,
        runId: nextRunId,
        flowName: nextFlowName,
        finalOutputs: nextOutputs,
        runError: nextRunError,
        selectedRunId: state.isStreaming ? state.selectedRunId : nextRunId ?? state.selectedRunId,
      };
    }),
}));

export const EDITABLE_NODE_TYPES: EditableNodeType[] = [
  "io.input",
  "io.output",
  "io.file",
  "router.code",
  "router.llm",
  "agent.claude",
  "agent.litellm",
  "agent.claude-code",
  "agent.codex",
  "mcp.server",
  "control.loop",
  "control.parallel",
  "control.join",
  "memory.memento",
];
