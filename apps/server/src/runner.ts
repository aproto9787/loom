import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import {
  flowSchema,
  type FlowNode,
  type LoomFlow,
  type RunEvent,
  type RunNodeResult,
  type RunResponse,
} from "@loom/core";
import { runtimeAdapters } from "@loom/adapters";
import { persistRun } from "./trace-store.js";

function resolveReference(reference: string, inputs: Record<string, unknown>, values: Map<string, unknown>): unknown {
  if (reference.startsWith("$inputs.")) {
    return inputs[reference.slice("$inputs.".length)];
  }

  if (reference.includes(" || ") ) {
    for (const candidate of reference.split(" || ")) {
      const resolved = resolveReference(candidate.trim(), inputs, values);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return undefined;
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

function evaluateCodeRouter(expression: string, resolvedInputs: Record<string, unknown>): string {
  const scopeKeys = Object.keys(resolvedInputs);
  const evaluator = new Function(...scopeKeys, `return (${expression});`);
  const branch = evaluator(...scopeKeys.map((key) => resolvedInputs[key]));

  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("router.code expression must return a non-empty string branch");
  }

  return branch;
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
    case "io.file": {
      const mode = node.config.mode === "write" ? "write" : "read";
      const filePath = typeof resolvedInputs.path === "string"
        ? resolvedInputs.path
        : typeof node.config.path === "string"
          ? node.config.path
          : undefined;
      if (!filePath) {
        throw new Error("io.file requires a string path input");
      }

      const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
      const absolutePath = path.resolve(workspaceRoot, filePath);
      if (!absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
        throw new Error("io.file path must stay within workspace root");
      }

      if (mode === "write") {
        const content = typeof resolvedInputs.content === "string"
          ? resolvedInputs.content
          : JSON.stringify(resolvedInputs.content ?? null, null, 2);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, "utf8");
        return { path: filePath, content, mode };
      }

      const content = await readFile(absolutePath, "utf8");
      return { path: filePath, content, mode };
    }
    case "router.code": {
      const expression = typeof node.config.expression === "string" ? node.config.expression : undefined;
      if (!expression) {
        throw new Error("router.code requires config.expression");
      }
      const branch = evaluateCodeRouter(expression, resolvedInputs);
      if (node.branches.length > 0 && !node.branches.includes(branch)) {
        throw new Error(`router.code returned unknown branch ${branch}`);
      }
      return { branch };
    }
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

function evaluateWhen(
  when: string,
  values: Map<string, unknown>,
): boolean {
  const [left, right] = when.split(/\s*==\s*/);
  if (!left || right === undefined) {
    return true;
  }
  const expected = right.trim().replace(/^['"]|['"]$/g, "");
  const [routerId, field] = left.trim().split(".");
  const routerOutput = values.get(routerId) as Record<string, unknown> | undefined;
  const actual = field ? routerOutput?.[field] : undefined;
  return actual === expected;
}

async function invokeAgentStream(
  node: FlowNode,
  resolvedInputs: Record<string, unknown>,
  onToken: (text: string) => void,
): Promise<unknown> {
  const adapter = runtimeAdapters.find((candidate) => candidate.supports(node.type));
  if (!adapter) {
    throw new Error(`No runtime adapter for ${node.type}`);
  }

  let finalOutput: unknown;
  for await (const event of adapter.invoke({ node, resolvedInputs })) {
    if (event.kind === "token") {
      onToken(event.text);
    } else if (event.kind === "error") {
      throw event.error;
    } else if (event.kind === "final") {
      finalOutput = event.output;
    }
  }

  return finalOutput;
}

export async function* streamRunFlow(
  flowPath: string,
  requestedInputs: Record<string, unknown>,
): AsyncGenerator<RunEvent, void, undefined> {
  const flow = await loadFlow(flowPath);
  const runId = randomUUID();
  const values = new Map<string, unknown>();
  const nodeResults: RunNodeResult[] = [];

  yield { kind: "run_start", runId, flowName: flow.name };

  try {
    for (const node of topologicalSort(flow.nodes)) {
      if (node.when && !evaluateWhen(node.when, values)) {
        yield { kind: "node_skipped", nodeId: node.id };
        continue;
      }

      yield { kind: "node_start", nodeId: node.id, type: node.type };

      const resolvedInputs = Object.fromEntries(
        Object.entries(node.inputs).map(([key, reference]) => [
          key,
          resolveReference(reference.from, requestedInputs, values) ?? reference.fallback,
        ]),
      );

      let output: unknown;
      try {
        if (node.type === "io.input") {
          output = Object.fromEntries(
            flow.inputs.map((input) => [input.id, requestedInputs[input.id]]),
          );
        } else if (node.type === "agent.claude" || node.type === "agent.litellm") {
          const tokens: { text: string }[] = [];
          const finalOutput = await invokeAgentStream(node, resolvedInputs, (text) => {
            tokens.push({ text });
          });
          for (const token of tokens) {
            yield { kind: "node_token", nodeId: node.id, text: token.text };
          }
          output = { output: finalOutput };
        } else {
          output = await executeNode(node, resolvedInputs);
        }
      } catch (nodeError) {
        const message = nodeError instanceof Error ? nodeError.message : String(nodeError);
        yield { kind: "node_error", nodeId: node.id, message };
        yield { kind: "run_error", runId, message };
        throw nodeError;
      }

      values.set(node.id, output);
      nodeResults.push({ nodeId: node.id, output });
      yield { kind: "node_complete", nodeId: node.id, output };
    }

    const outputs = Object.fromEntries(
      flow.outputs.map((output) => [output.id, resolveReference(output.from, requestedInputs, values)]),
    );

    persistRun({
      runId,
      flowName: flow.name,
      flowPath,
      requestedInputs,
      outputs,
      nodeResults,
    });

    yield {
      kind: "run_complete",
      runId,
      flowName: flow.name,
      outputs,
      nodeResults,
    };
  } catch (error) {
    // run_error already yielded above, but surface unexpected errors here too
    if (!(error instanceof Error)) {
      throw new Error(String(error));
    }
    throw error;
  }
}

export async function runFlow(
  flowPath: string,
  requestedInputs: Record<string, unknown>,
): Promise<RunResponse> {
  let response: RunResponse | undefined;
  for await (const event of streamRunFlow(flowPath, requestedInputs)) {
    if (event.kind === "run_complete") {
      response = {
        runId: event.runId,
        flowName: event.flowName,
        requestedInputs,
        outputs: event.outputs,
        nodeResults: event.nodeResults,
      };
    }
  }
  if (!response) {
    throw new Error("flow did not produce a run_complete event");
  }
  return response;
}
