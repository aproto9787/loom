import { create } from "zustand";
import type { AgentConfig, AgentType, FlowDefinition, RunEvent } from "@loom/core";

// --- Agent path helpers ---

export function getAgentAtPath(
  root: AgentConfig,
  path: string[],
): AgentConfig | undefined {
  let current: AgentConfig | undefined = root;
  for (let i = 1; i < path.length; i++) {
    current = current?.agents?.find((a) => a.name === path[i]);
    if (!current) return undefined;
  }
  return current;
}

function updateAgentAtPath(
  root: AgentConfig,
  path: string[],
  updater: (agent: AgentConfig) => AgentConfig,
): AgentConfig {
  if (path.length <= 1) return updater({ ...root });
  const clone: AgentConfig = { ...root, agents: root.agents ? [...root.agents] : [] };
  const childName = path[1];
  const idx = clone.agents!.findIndex((a) => a.name === childName);
  if (idx === -1) return clone;
  clone.agents![idx] = updateAgentAtPath(clone.agents![idx], path.slice(1), updater);
  return clone;
}

function removeAgentAtPath(root: AgentConfig, path: string[]): AgentConfig {
  if (path.length <= 1) return root; // can't remove root
  if (path.length === 2) {
    return {
      ...root,
      agents: (root.agents ?? []).filter((a) => a.name !== path[1]),
    };
  }
  const clone: AgentConfig = { ...root, agents: root.agents ? [...root.agents] : [] };
  const childName = path[1];
  const idx = clone.agents!.findIndex((a) => a.name === childName);
  if (idx === -1) return clone;
  clone.agents![idx] = removeAgentAtPath(clone.agents![idx], path.slice(1));
  return clone;
}

function addAgentToPath(
  root: AgentConfig,
  parentPath: string[],
  newAgent: AgentConfig,
): AgentConfig {
  return updateAgentAtPath(root, parentPath, (parent) => ({
    ...parent,
    agents: [...(parent.agents ?? []), newAgent],
  }));
}

function nextAgentName(parent: AgentConfig, type: AgentType): string {
  const base = type === "claude-code" ? "agent" : "codex-agent";
  let counter = 1;
  const existing = new Set((parent.agents ?? []).map((a) => a.name));
  while (existing.has(`${base}-${counter}`)) counter++;
  return `${base}-${counter}`;
}

function cloneFlow(flow: FlowDefinition): FlowDefinition {
  return JSON.parse(JSON.stringify(flow)) as FlowDefinition;
}

function flowsAreEqual(
  a: FlowDefinition | undefined,
  b: FlowDefinition | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Run event types ---

export type RunStreamEvent =
  | { kind: "run_start"; runId: string; flowName: string }
  | { kind: "agent_start"; agentName: string; agentType: AgentType }
  | { kind: "agent_token"; agentName: string; token: string }
  | { kind: "agent_complete"; agentName: string; output: string }
  | { kind: "agent_error"; agentName: string; error: string }
  | { kind: "agent_delegate"; parentAgent: string; childAgent: string }
  | { kind: "run_complete"; output: string }
  | { kind: "run_error"; message: string };

export type AgentRunState = "pending" | "running" | "done" | "error";

export interface AgentRuntime {
  name: string;
  agentType?: AgentType;
  state: AgentRunState;
  tokens: string[];
  output?: string;
  error?: string;
  parentAgent?: string;
  depth: number;
}

// --- Store ---

interface StudioState {
  flowPath: string;
  availableFlows: string[];
  loadedFlow?: FlowDefinition;
  flowDraft?: FlowDefinition;
  isDirty: boolean;
  selectedAgentPath: string[];
  isSaving: boolean;
  saveError?: string;
  loadError?: string;

  // Run state
  isStreaming: boolean;
  runId?: string;
  flowName?: string;
  events: RunStreamEvent[];
  agentRuntimes: Record<string, AgentRuntime>;
  finalOutput?: string;
  runError?: string;

  // Actions
  setFlowPath: (value: string) => void;
  setAvailableFlows: (flows: string[]) => void;
  setLoadedFlow: (flow: FlowDefinition | undefined) => void;
  setLoadError: (message: string | undefined) => void;

  selectAgent: (path: string[]) => void;
  updateAgent: (path: string[], config: Partial<AgentConfig>) => void;
  addAgent: (parentPath: string[], type: AgentType) => void;
  removeAgent: (path: string[]) => void;

  beginSave: () => void;
  endSave: (savedFlow: FlowDefinition) => void;
  setSaveError: (message: string | undefined) => void;

  beginStream: () => void;
  ingest: (event: RunStreamEvent) => void;
  endStream: () => void;
}

export const useRunStore = create<StudioState>((set) => ({
  flowPath: "examples/simple.yaml",
  availableFlows: [],
  isDirty: false,
  selectedAgentPath: [],
  isSaving: false,
  isStreaming: false,
  events: [],
  agentRuntimes: {},

  setFlowPath: (value) =>
    set({
      flowPath: value,
      flowDraft: undefined,
      loadedFlow: undefined,
      isDirty: false,
      selectedAgentPath: [],
      saveError: undefined,
      loadError: undefined,
    }),

  setAvailableFlows: (flows) => set({ availableFlows: flows }),

  setLoadedFlow: (flow) =>
    set({
      loadedFlow: flow,
      flowDraft: flow ? cloneFlow(flow) : undefined,
      isDirty: false,
      selectedAgentPath: flow ? [flow.orchestrator.name] : [],
      saveError: undefined,
      loadError: undefined,
    }),

  setLoadError: (message) => set({ loadError: message }),

  selectAgent: (path) => set({ selectedAgentPath: path }),

  updateAgent: (path, config) =>
    set((state) => {
      if (!state.flowDraft) return state;
      const draft = cloneFlow(state.flowDraft);
      draft.orchestrator = updateAgentAtPath(draft.orchestrator, path, (agent) => ({
        ...agent,
        ...config,
      }));
      // If name changed, update selectedAgentPath
      let nextPath = state.selectedAgentPath;
      if (config.name && path.length > 0) {
        nextPath = [...path.slice(0, -1), config.name];
      }
      return {
        flowDraft: draft,
        isDirty: !flowsAreEqual(draft, state.loadedFlow),
        selectedAgentPath: nextPath,
      };
    }),

  addAgent: (parentPath, type) =>
    set((state) => {
      if (!state.flowDraft) return state;
      const draft = cloneFlow(state.flowDraft);
      const parent = getAgentAtPath(draft.orchestrator, parentPath);
      if (!parent) return state;
      const name = nextAgentName(parent, type);
      const newAgent: AgentConfig = { name, type };
      draft.orchestrator = addAgentToPath(draft.orchestrator, parentPath, newAgent);
      return {
        flowDraft: draft,
        isDirty: !flowsAreEqual(draft, state.loadedFlow),
        selectedAgentPath: [...parentPath, name],
      };
    }),

  removeAgent: (path) =>
    set((state) => {
      if (!state.flowDraft || path.length <= 1) return state;
      const draft = cloneFlow(state.flowDraft);
      draft.orchestrator = removeAgentAtPath(draft.orchestrator, path);
      // Deselect if the removed agent was selected
      const removedName = path[path.length - 1];
      const isSelected =
        state.selectedAgentPath.length >= path.length &&
        state.selectedAgentPath.slice(0, path.length).join("/") === path.join("/");
      return {
        flowDraft: draft,
        isDirty: !flowsAreEqual(draft, state.loadedFlow),
        selectedAgentPath: isSelected ? path.slice(0, -1) : state.selectedAgentPath,
      };
    }),

  beginSave: () => set({ isSaving: true, saveError: undefined }),
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
      agentRuntimes: {},
      finalOutput: undefined,
      runError: undefined,
      runId: undefined,
      flowName: undefined,
    }),

  endStream: () => set({ isStreaming: false }),

  ingest: (event) =>
    set((state) => {
      const nextEvents = [...state.events, event];
      const nextAgents = { ...state.agentRuntimes };
      let nextRunId = state.runId;
      let nextFlowName = state.flowName;
      let nextOutput = state.finalOutput;
      let nextRunError = state.runError;

      switch (event.kind) {
        case "run_start":
          nextRunId = event.runId;
          nextFlowName = event.flowName;
          break;
        case "agent_start": {
          const existing = nextAgents[event.agentName];
          nextAgents[event.agentName] = {
            name: event.agentName,
            agentType: event.agentType,
            state: "running",
            tokens: existing?.tokens ?? [],
            depth: existing?.depth ?? 0,
            parentAgent: existing?.parentAgent,
          };
          break;
        }
        case "agent_token": {
          const current = nextAgents[event.agentName] ?? {
            name: event.agentName,
            state: "running" as const,
            tokens: [],
            depth: 0,
          };
          nextAgents[event.agentName] = {
            ...current,
            tokens: [...current.tokens, event.token],
          };
          break;
        }
        case "agent_complete": {
          const current = nextAgents[event.agentName];
          if (current) {
            nextAgents[event.agentName] = {
              ...current,
              state: "done",
              output: event.output,
            };
          }
          break;
        }
        case "agent_error": {
          const current = nextAgents[event.agentName];
          if (current) {
            nextAgents[event.agentName] = {
              ...current,
              state: "error",
              error: event.error,
            };
          }
          break;
        }
        case "agent_delegate": {
          const parent = nextAgents[event.parentAgent];
          const parentDepth = parent?.depth ?? 0;
          nextAgents[event.childAgent] = {
            name: event.childAgent,
            state: "pending",
            tokens: [],
            parentAgent: event.parentAgent,
            depth: parentDepth + 1,
          };
          break;
        }
        case "run_complete":
          nextOutput = event.output;
          break;
        case "run_error":
          nextRunError = event.message;
          break;
      }

      return {
        events: nextEvents,
        agentRuntimes: nextAgents,
        runId: nextRunId,
        flowName: nextFlowName,
        finalOutput: nextOutput,
        runError: nextRunError,
      };
    }),
}));
