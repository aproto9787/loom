import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { flowSchema, type FlowNode, type LoomFlow, type RunNodeResult, type RunResponse } from "@loom/core";
import { runtimeAdapters } from "@loom/adapters";

function resolveReference(reference: string, inputs: Record<string, unknown>, values: Map<string, unknown>): unknown {
  if (reference.startsWith("$inputs.")) {
    return inputs[reference.slice("$inputs.".length)];
  }

  const [nodeId, outputName] = reference.split(".");
  const result = values.get(nodeId);

  if (result && typeof result === "object" && outputName in (result as Record<string, unknown>)) {
    return (result as Record<string, unknown>)[outputName];
  }

  return result;
}

function buildDependencies(node: FlowNode): string[] {
  return Object.values(node.inputs)
    .map((input) => input.from)
    .filter((from) => !from.startsWith("$inputs."))
    .map((from) => from.split(".")[0]);
}

function topologicalSort(nodes: FlowNode[]): FlowNode[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const pending = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const deps = new Set(buildDependencies(node));
    pending.set(node.id, deps);
    for (const dependency of deps) {
      const group = dependents.get(dependency) ?? [];
      group.push(node.id);
      dependents.set(dependency, group);
    }
  }

  const ready = nodes.filter((node) => pending.get(node.id)?.size === 0).map((node) => node.id);
  const ordered: FlowNode[] = [];

  while (ready.length > 0) {
    const nextId = ready.shift()!;
    const node = nodeMap.get(nextId);
    if (!node) {
      continue;
    }
    ordered.push(node);

    for (const dependentId of dependents.get(nextId) ?? []) {
      const deps = pending.get(dependentId);
      if (!deps) {
        continue;
      }
      deps.delete(nextId);
      if (deps.size === 0) {
        ready.push(dependentId);
      }
    }
  }

  if (ordered.length !== nodes.length) {
    throw new Error("Flow contains a cycle");
  }

  return ordered;
}

async function invokeAgent(node: FlowNode, resolvedInputs: Record<string, unknown>): Promise<unknown> {
  const adapter = runtimeAdapters.find((candidate) => candidate.supports(node.type));
  if (!adapter) {
    throw new Error(`No runtime adapter for ${node.type}`);
  }

  let finalOutput: unknown;
  for await (const event of adapter.invoke({ node, resolvedInputs })) {
    if (event.kind === "error") {
      throw event.error;
    }
    if (event.kind === "final") {
      finalOutput = event.output;
    }
  }

  return finalOutput;
}

async function executeNode(node: FlowNode, resolvedInputs: Record<string, unknown>): Promise<unknown> {
  switch (node.type) {
    case "io.input":
      return resolvedInputs;
    case "io.output":
      return { output: resolvedInputs.value ?? resolvedInputs.result ?? Object.values(resolvedInputs)[0] };
    case "agent.claude":
    case "agent.litellm":
      return { output: await invokeAgent(node, resolvedInputs) };
    default:
      throw new Error(`Node type ${node.type} is not supported in this slice`);
  }
}

export async function loadFlow(flowPath: string): Promise<LoomFlow> {
  const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
  const absolutePath = path.resolve(workspaceRoot, flowPath);
  const raw = await readFile(absolutePath, "utf8");
  return flowSchema.parse(YAML.parse(raw));
}

export async function runFlow(flowPath: string, requestedInputs: Record<string, unknown>): Promise<RunResponse> {
  const flow = await loadFlow(flowPath);
  const values = new Map<string, unknown>();
  const nodeResults: RunNodeResult[] = [];

  for (const node of topologicalSort(flow.nodes)) {
    const resolvedInputs = Object.fromEntries(
      Object.entries(node.inputs).map(([key, reference]) => [
        key,
        resolveReference(reference.from, requestedInputs, values) ?? reference.fallback,
      ]),
    );

    if (node.type === "io.input") {
      const payload = Object.fromEntries(
        flow.inputs.map((input) => [input.id, requestedInputs[input.id]]),
      );
      values.set(node.id, payload);
      nodeResults.push({ nodeId: node.id, output: payload });
      continue;
    }

    const output = await executeNode(node, resolvedInputs);
    values.set(node.id, output);
    nodeResults.push({ nodeId: node.id, output });
  }

  const outputs = Object.fromEntries(
    flow.outputs.map((output) => [output.id, resolveReference(output.from, requestedInputs, values)]),
  );

  return {
    flowName: flow.name,
    requestedInputs,
    outputs,
    nodeResults,
  };
}
