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
  env: z.record(z.string()).optional(),
});

export const referenceSchema = z.object({
  from: z.string().min(1),
  fallback: z.unknown().optional(),
});

export const branchConditionSchema = z.object({
  branch: z.string().min(1),
  target: z.string().min(1),
});

export const flowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "io.input",
    "io.output",
    "io.file",
    "agent.claude",
    "agent.litellm",
    "agent.claude-code",
    "agent.codex",
    "router.code",
    "router.llm",
    "control.loop",
    "control.parallel",
    "control.join",
    "memory.blackboard",
    "memory.memento",
    "mcp.server",
  ]),
  config: z.record(z.unknown()).default({}),
  mcps: z.array(z.string()).default([]),
  inputs: z.record(referenceSchema).default({}),
  outputs: z.record(z.string()).default({}),
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

export interface InvokeContext {
  node: FlowNode;
  resolvedInputs: Record<string, unknown>;
}

export type InvokeEvent =
  | { kind: "token"; text: string }
  | { kind: "tool_call"; name: string; args: unknown }
  | { kind: "tool_result"; name: string; result: unknown }
  | { kind: "final"; output: unknown }
  | { kind: "error"; error: Error };

export interface RuntimeAdapter {
  id: string;
  supports(nodeType: FlowNode["type"]): boolean;
  invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent>;
}

export interface RunRequest {
  flowPath: string;
  inputs: Record<string, unknown>;
}

export interface RunNodeResult {
  nodeId: string;
  output: unknown;
}

export interface RunResponse {
  flowName: string;
  requestedInputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  nodeResults: RunNodeResult[];
}
