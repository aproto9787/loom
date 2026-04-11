import { create } from "zustand";
import type { LoomFlow } from "@loom/core";

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
      nodeResults: Array<{ nodeId: string; output: unknown }>;
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
}

interface RunState {
  flowPath: string;
  inputsJson: string;
  availableFlows: string[];
  loadedFlow?: LoomFlow;
  isStreaming: boolean;
  runId?: string;
  flowName?: string;
  events: RunStreamEvent[];
  nodeRuntimes: Record<string, NodeRuntime>;
  finalOutputs?: Record<string, unknown>;
  runError?: string;
  loadError?: string;
  setFlowPath: (value: string) => void;
  setInputsJson: (value: string) => void;
  setAvailableFlows: (flows: string[]) => void;
  setLoadedFlow: (flow: LoomFlow | undefined) => void;
  setLoadError: (message: string | undefined) => void;
  beginStream: () => void;
  ingest: (event: RunStreamEvent) => void;
  endStream: () => void;
}

function emptyNode(id: string): NodeRuntime {
  return { id, state: "pending", tokens: [] };
}

export const useRunStore = create<RunState>((set) => ({
  flowPath: "examples/hello.yaml",
  inputsJson: '{\n  "topic": "loom studio"\n}',
  availableFlows: [],
  isStreaming: false,
  events: [],
  nodeRuntimes: {},
  setFlowPath: (value) => set({ flowPath: value }),
  setInputsJson: (value) => set({ inputsJson: value }),
  setAvailableFlows: (flows) => set({ availableFlows: flows }),
  setLoadedFlow: (flow) => set({ loadedFlow: flow, loadError: undefined }),
  setLoadError: (message) => set({ loadError: message }),
  beginStream: () =>
    set({
      isStreaming: true,
      events: [],
      nodeRuntimes: {},
      finalOutputs: undefined,
      runError: undefined,
      runId: undefined,
      flowName: undefined,
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
          nextNodes[event.nodeId] = {
            ...current,
            state: "done",
            output: event.output,
            meta: event.meta ?? current.meta,
          };
          break;
        }
        case "node_skipped": {
          const current = nextNodes[event.nodeId] ?? emptyNode(event.nodeId);
          nextNodes[event.nodeId] = {
            ...current,
            state: "skipped",
          };
          break;
        }
        case "node_error": {
          const current = nextNodes[event.nodeId] ?? emptyNode(event.nodeId);
          nextNodes[event.nodeId] = {
            ...current,
            state: "error",
            error: event.message,
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
      };
    }),
}));
