import { z } from "zod";

export const inputDefinitionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["text", "json", "file", "stream", "control"]),
  prompt: z.string().optional(),
});

export const mcpSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export const referenceSchema = z.object({
  from: z.string().min(1),
  fallback: z.unknown().optional(),
});

export const branchConditionSchema = z.object({
  branch: z.string().min(1),
  target: z.string().min(1),
});

export const supportedNodeTypesV01 = [
  "io.input",
  "io.output",
  "io.file",
  "router.code",
  "agent.claude",
  "agent.litellm",
  "mcp.server",
] as const;

// NOTE: v0.1 slice. v0.2+ types (router.llm, control.*, memory.*, agent.claude-code, agent.codex) will join this schema in the next milestone.
export const flowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(supportedNodeTypesV01),
  config: z.record(z.string(), z.unknown()).default({}),
  mcps: z.array(z.string()).default([]),
  inputs: z.record(z.string(), referenceSchema).default({}),
  outputs: z.record(z.string(), z.string()).default({}),
  branches: z.array(z.string()).default([]),
  when: z.string().optional(),
});

export const outputDefinitionSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
});

export const flowSchema = z.object({
  version: z.literal("loom/v1"),
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: z.array(inputDefinitionSchema).default([]),
  mcps: z.array(mcpSchema).default([]),
  nodes: z.array(flowNodeSchema).default([]),
  outputs: z.array(outputDefinitionSchema).default([]),
});

export type InputDefinition = z.infer<typeof inputDefinitionSchema>;
export type FlowNode = z.infer<typeof flowNodeSchema>;
export type LoomFlow = z.infer<typeof flowSchema>;
export type NodeResultValue = string | number | boolean | null | Record<string, unknown> | unknown[];

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpInvokeServer {
  tools: McpToolDescriptor[];
  callTool: (name: string, args: unknown) => Promise<unknown>;
}

export interface InvokeContext {
  node: FlowNode;
  resolvedInputs: Record<string, unknown>;
  runtime?: RuntimeSession;
  mcps?: Record<string, McpInvokeServer>;
}

export interface RuntimeSession {
  registerCleanup(cleanup: () => void | Promise<void>): void;
  getOrCreateResource<T>(key: string, factory: () => T): T;
}

export type InvokeEvent =
  | { kind: "token"; text: string }
  | { kind: "tool_call"; name: string; args: unknown }
  | { kind: "tool_result"; name: string; result: unknown }
  | { kind: "final"; output: unknown }
  | { kind: "error"; error: Error };

export interface RuntimeAdapter {
  id: string;
  // Accepts any node type string: future (v0.2+) types may not yet appear in
  // FlowNode["type"] while their adapter stubs still need to advertise support.
  supports(nodeType: string): boolean;
  invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent>;
}

export interface RunRequest {
  flowPath: string;
  inputs: Record<string, unknown>;
}

export interface RunNodeResult {
  nodeId: string;
  output: unknown;
  startedAt?: string;
  finishedAt?: string;
}

export interface RunResponse {
  runId: string;
  flowName: string;
  requestedInputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  nodeResults: RunNodeResult[];
}

// Streaming event types surfaced by the runner through `streamRunFlow()`
// and forwarded to SSE clients. `kind` is used as the SSE `event:` field
// and the remainder of each object is the JSON `data:` payload.
export type RunEvent =
  | { kind: "run_start"; runId: string; flowName: string }
  | { kind: "node_start"; nodeId: string; type: string }
  | { kind: "node_token"; nodeId: string; text: string }
  | { kind: "node_complete"; nodeId: string; output: unknown; meta?: Record<string, unknown> }
  | { kind: "node_skipped"; nodeId: string }
  | { kind: "node_error"; nodeId: string; message: string }
  | {
      kind: "run_complete";
      runId: string;
      flowName: string;
      outputs: Record<string, unknown>;
      nodeResults: RunNodeResult[];
    }
  | { kind: "run_error"; runId: string; message: string };
