import { runtimeAdapters } from "@loom/adapters";
import type {
  FlowNode,
  InvokeContext,
  InvokeEvent,
  RuntimeAdapter,
  RuntimeSession,
} from "@loom/core";
import { getControlJoinConfig, getControlLoopConfig, validateNode } from "./validate.js";

export interface NodeExecutionContext {
  node: FlowNode;
  resolvedInputs: Record<string, unknown>;
  runtime?: RuntimeSession;
  onEvent?: (event: InvokeEvent) => void;
}

export interface ControlBranchResult {
  nodeId: string;
  output: unknown;
  startedAt?: string;
  finishedAt?: string;
  completionOrder?: number;
}

export interface ControlJoinEntry {
  inputName: string;
  nodeId?: string;
  output: unknown;
  startedAt?: string;
  finishedAt?: string;
  completionOrder?: number;
}

function getAdapter(nodeType: FlowNode["type"]): RuntimeAdapter {
  const adapter = runtimeAdapters.find((candidate) => candidate.supports(nodeType));
  if (!adapter) {
    throw new Error(`No runtime adapter for ${nodeType}`);
  }
  return adapter;
}

function getInputText(resolvedInputs: Record<string, unknown>): string {
  if (typeof resolvedInputs.text === "string" && resolvedInputs.text.trim().length > 0) {
    return resolvedInputs.text;
  }

  if (typeof resolvedInputs.prompt === "string" && resolvedInputs.prompt.trim().length > 0) {
    return resolvedInputs.prompt;
  }

  const values = Object.values(resolvedInputs);
  if (values.length === 1 && typeof values[0] === "string" && values[0].trim().length > 0) {
    return values[0];
  }

  if (Object.keys(resolvedInputs).length === 0) {
    return "";
  }

  return JSON.stringify(resolvedInputs, null, 2);
}

function pickPrimaryInput(resolvedInputs: Record<string, unknown>): unknown {
  if (resolvedInputs.value !== undefined) {
    return resolvedInputs.value;
  }

  if (resolvedInputs.item !== undefined) {
    return resolvedInputs.item;
  }

  if (resolvedInputs.items !== undefined) {
    return resolvedInputs.items;
  }

  const values = Object.values(resolvedInputs);
  if (values.length === 1) {
    return values[0];
  }

  return resolvedInputs;
}

async function invokeAdapter(ctx: InvokeContext, onEvent?: (event: InvokeEvent) => void): Promise<unknown> {
  const adapter = getAdapter(ctx.node.type);
  let finalOutput: unknown;

  for await (const event of adapter.invoke(ctx)) {
    if (event.kind === "error") {
      throw event.error;
    }

    if (event.kind === "final") {
      finalOutput = event.output;
      continue;
    }

    onEvent?.(event);
  }

  return finalOutput;
}

function getRouterAdapterType(node: FlowNode): "agent.claude" | "agent.litellm" {
  const adapter = typeof node.config.adapter === "string" ? node.config.adapter : undefined;
  if (adapter === "agent.claude" || adapter === "agent.litellm") {
    return adapter;
  }

  const provider = typeof node.config.provider === "string" ? node.config.provider.toLowerCase() : "";
  if (provider === "claude" || provider === "anthropic") {
    return "agent.claude";
  }
  if (provider === "litellm" || provider === "openai") {
    return "agent.litellm";
  }

  return String(node.config.model).startsWith("claude") ? "agent.claude" : "agent.litellm";
}

function buildRouterPrompt(branches: string[], inputText: string): string {
  return [
    "Choose exactly one branch name from the provided list.",
    `Allowed branches: ${branches.join(", ")}`,
    "Return only the branch name. Do not explain your choice.",
    "Input:",
    inputText,
  ].join("\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBranch(output: unknown, branches: string[]): string {
  const text = typeof output === "string"
    ? output
    : output === null || output === undefined
      ? ""
      : JSON.stringify(output);

  const direct = text.trim().replace(/^['"`]|['"`]$/g, "");
  if (branches.includes(direct)) {
    return direct;
  }

  try {
    const parsed = JSON.parse(text) as { branch?: unknown };
    if (typeof parsed.branch === "string" && branches.includes(parsed.branch)) {
      return parsed.branch;
    }
  } catch {
    // Ignore non-JSON responses.
  }

  const byLength = [...branches].sort((left, right) => right.length - left.length);
  for (const branch of byLength) {
    if (new RegExp(`\\b${escapeRegExp(branch)}\\b`).test(text)) {
      return branch;
    }
  }

  throw new Error(`router.llm could not extract a branch from response: ${text}`);
}

function pickMockBranch(branches: string[], inputText: string): string {
  const loweredInput = inputText.toLowerCase();
  const match = branches.find((branch) => loweredInput.includes(branch.toLowerCase()));
  return match ?? branches[0]!;
}

export function buildControlLoopIterationValue(
  resolvedInputs: Record<string, unknown>,
  iteration: number,
  item: unknown,
  last: Record<string, unknown> | null,
): Record<string, unknown> {
  const primary = item !== undefined ? item : pickPrimaryInput(resolvedInputs);
  return {
    output: primary,
    value: primary,
    item,
    iteration,
    index: iteration,
    inputs: resolvedInputs,
    last,
  };
}

export function buildControlLoopOutput(
  node: FlowNode,
  iterations: Array<Record<string, unknown>>,
  maxReached: boolean,
): Record<string, unknown> {
  const config = getControlLoopConfig(node);
  const last = iterations.at(-1) ?? null;

  return {
    output: iterations,
    mode: config.mode,
    max: config.max,
    condition: config.condition,
    iterationCount: iterations.length,
    iterations,
    last,
    maxReached,
  };
}

export function buildControlParallelOutput(
  resolvedInputs: Record<string, unknown>,
  branches: ControlBranchResult[],
): Record<string, unknown> {
  return {
    output: branches.map((branch) => branch.output),
    value: pickPrimaryInput(resolvedInputs),
    inputs: resolvedInputs,
    branches,
    branchCount: branches.length,
  };
}

export function buildControlJoinOutput(
  node: FlowNode,
  entries: ControlJoinEntry[],
): Record<string, unknown> {
  const { mode } = getControlJoinConfig(node);
  const byCompletion = [...entries].sort((left, right) => {
    const leftOrder = left.completionOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.completionOrder ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });

  let output: unknown;
  let selected: ControlJoinEntry | undefined;

  if (mode === "all") {
    output = entries.map((entry) => entry.output);
  } else if (mode === "any") {
    selected = byCompletion.find((entry) => entry.output !== undefined) ?? byCompletion[0];
    output = selected?.output;
  } else {
    selected = byCompletion[0];
    output = selected?.output;
  }

  return {
    output,
    mode,
    entries,
    branchCount: entries.length,
    selectedInput: selected?.inputName,
    selectedNodeId: selected?.nodeId,
  };
}

async function executeRouterNode(context: NodeExecutionContext): Promise<unknown> {
  const branches = context.node.branches;
  if (branches.length === 0) {
    throw new Error("router.llm requires at least one branch");
  }

  const inputText = getInputText(context.resolvedInputs);
  if (process.env.LOOM_MOCK === "1") {
    return { branch: pickMockBranch(branches, inputText) };
  }

  const llmNode: FlowNode = {
    ...context.node,
    type: getRouterAdapterType(context.node),
    config: {
      model: context.node.config.model,
      system: context.node.config.system,
    },
    mcps: [],
    outputs: {},
    branches: [],
  };

  const output = await invokeAdapter({
    node: llmNode,
    resolvedInputs: { prompt: buildRouterPrompt(branches, inputText) },
    runtime: context.runtime,
  }, context.onEvent);

  return { branch: extractBranch(output, branches) };
}

async function executeAgentSessionNode(context: NodeExecutionContext): Promise<unknown> {
  const output = await invokeAdapter({
    node: context.node,
    resolvedInputs: context.resolvedInputs,
    runtime: context.runtime,
  }, context.onEvent);

  return { output };
}

async function executeMementoNode(context: NodeExecutionContext): Promise<unknown> {
  const operation = String(context.node.config.operation) as "remember" | "recall" | "forget";
  const result = await invokeAdapter({
    node: context.node,
    resolvedInputs: context.resolvedInputs,
    runtime: context.runtime,
  }, context.onEvent);

  return { operation, result };
}

export async function executeNode(context: NodeExecutionContext): Promise<unknown | undefined> {
  const errors = validateNode(context.node);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  switch (context.node.type) {
    case "agent.claude-code":
    case "agent.codex":
      return executeAgentSessionNode(context);
    case "router.llm":
      return executeRouterNode(context);
    case "control.loop":
      return buildControlLoopOutput(context.node, [], false);
    case "control.parallel":
      return buildControlParallelOutput(context.resolvedInputs, []);
    case "control.join": {
      const entries = Object.entries(context.resolvedInputs).map(([inputName, output]) => ({ inputName, output }));
      return buildControlJoinOutput(context.node, entries);
    }
    case "memory.memento":
      return executeMementoNode(context);
    default:
      return undefined;
  }
}
