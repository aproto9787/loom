import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import type { InvokeEvent } from "@loom/core";
import {
  flowSchema,
  type FlowNode,
  type LoomFlow,
  type McpInvokeServer,
  type RunEvent,
  type RuntimeSession,
  type RunNodeResult,
  type RunResponse,
} from "@loom/core";
import {
  buildControlJoinOutput,
  buildControlLoopIterationValue,
  buildControlLoopOutput,
  buildControlParallelOutput,
  buildNodeGraph,
  executeNode as executeExtendedNode,
  getControlLoopConfig,
  validateFlow,
  type ControlBranchResult,
  type ControlJoinEntry,
} from "@loom/nodes";
import { MCPStdioClient, runtimeAdapters, type McpClientOptions } from "@loom/adapters";
import { persistRun } from "./trace-store.js";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

function getReferenceNodeIds(reference: string): string[] {
  return reference
    .split(" || ")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0 && !candidate.startsWith("$inputs."))
    .map((candidate) => candidate.split(".")[0]!)
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

function resolveReference(reference: string, inputs: Record<string, unknown>, values: Map<string, unknown>): unknown {
  if (reference.startsWith("$inputs.")) {
    return inputs[reference.slice("$inputs.".length)];
  }

  if (reference.includes(" || ")) {
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

  if (outputName && result && typeof result === "object" && outputName in (result as Record<string, unknown>)) {
    return (result as Record<string, unknown>)[outputName];
  }

  return result;
}

function buildDependencies(node: FlowNode): string[] {
  return [...new Set(Object.values(node.inputs).flatMap((input) => getReferenceNodeIds(input.from)))];
}

function topologicalSort(nodes: FlowNode[]): FlowNode[] {
  const graph = buildNodeGraph(nodes);
  const pending = new Map<string, Set<string>>();

  for (const node of nodes) {
    pending.set(node.id, new Set(graph.dependencies.get(node.id) ?? []));
  }

  const ready = nodes.filter((node) => pending.get(node.id)?.size === 0).map((node) => node.id);
  const ordered: FlowNode[] = [];

  while (ready.length > 0) {
    const nextId = ready.shift()!;
    const node = graph.nodeMap.get(nextId);
    if (!node) {
      continue;
    }
    ordered.push(node);

    for (const dependentId of graph.dependents.get(nextId) ?? []) {
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

class RunnerRuntimeSession implements RuntimeSession {
  private readonly resources = new Map<string, unknown>();
  private readonly cleanups: Array<() => void | Promise<void>> = [];

  registerCleanup(cleanup: () => void | Promise<void>): void {
    this.cleanups.push(cleanup);
  }

  getOrCreateResource<T>(key: string, factory: () => T): T {
    if (this.resources.has(key)) {
      return this.resources.get(key) as T;
    }

    const resource = factory();
    this.resources.set(key, resource);
    return resource;
  }

  async cleanup(): Promise<void> {
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop();
      if (!cleanup) {
        continue;
      }

      try {
        await cleanup();
      } catch {
        /* swallow cleanup errors */
      }
    }
  }
}

class NodeExecutionFailure extends Error {
  constructor(readonly nodeId: string, message: string) {
    super(message);
    this.name = "NodeExecutionFailure";
  }
}

function getMcpClientOptions(node: Pick<FlowNode, "config"> | McpClientOptions): McpClientOptions {
  if ("command" in node) {
    return {
      command: node.command,
      args: node.args,
      env: node.env,
      cwd: node.cwd ?? workspaceRoot,
    };
  }

  const command = typeof node.config.command === "string" ? node.config.command : undefined;
  if (!command) {
    throw new Error("mcp.server requires config.command");
  }
  const args = Array.isArray(node.config.args)
    ? (node.config.args.filter((value) => typeof value === "string") as string[])
    : [];
  const env: Record<string, string> = {};
  if (node.config.env && typeof node.config.env === "object") {
    for (const [key, value] of Object.entries(node.config.env as Record<string, unknown>)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
  }
  return { command, args, env, cwd: workspaceRoot };
}

async function getOrCreateMcpServer(runtime: RuntimeSession, serverId: string, options: McpClientOptions): Promise<McpInvokeServer> {
  return runtime.getOrCreateResource(`mcp:${serverId}`, () => {
    const client = new MCPStdioClient(getMcpClientOptions(options));
    runtime.registerCleanup(() => client.close());
    return (async () => {
      await client.initialize();
      const tools = await client.listTools();
      return {
        tools,
        callTool: (name: string, args: unknown) => client.callTool(name, args),
      } satisfies McpInvokeServer;
    })();
  });
}

async function buildAgentMcps(node: FlowNode, flow: LoomFlow, runtime: RuntimeSession): Promise<Record<string, McpInvokeServer> | undefined> {
  if (node.mcps.length === 0) {
    return undefined;
  }

  const boundServers = await Promise.all(node.mcps.map(async (serverId) => {
    const server = flow.mcps.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error(`agent node ${node.id} references unknown MCP server ${serverId}`);
    }
    const handle = await getOrCreateMcpServer(runtime, serverId, getMcpClientOptions(server));
    return [serverId, handle] as const;
  }));

  return Object.fromEntries(boundServers);
}

function buildNodeMeta(node: FlowNode, output: unknown): Record<string, unknown> | undefined {
  if (node.type !== "mcp.server") {
    return undefined;
  }

  const record = output && typeof output === "object" ? output as Record<string, unknown> : undefined;
  const tools = Array.isArray(record?.tools) ? record.tools : [];

  return {
    mcp: {
      tools,
      toolNames: tools
        .map((tool) => tool && typeof tool === "object" ? (tool as Record<string, unknown>).name : undefined)
        .filter((name): name is string => typeof name === "string"),
    },
  };
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

function evaluateLoopCondition(
  expression: string,
  resolvedInputs: Record<string, unknown>,
  iteration: number,
  last: Record<string, unknown> | null,
): boolean {
  const scope = {
    ...resolvedInputs,
    iteration,
    index: iteration,
    last,
  };
  const keys = Object.keys(scope);
  const evaluator = new Function(...keys, `return Boolean(${expression});`);
  return Boolean(evaluator(...keys.map((key) => scope[key as keyof typeof scope])));
}

function getLoopItems(resolvedInputs: Record<string, unknown>): unknown[] {
  if (Array.isArray(resolvedInputs.items)) {
    return resolvedInputs.items;
  }

  if (Array.isArray(resolvedInputs.value)) {
    return resolvedInputs.value;
  }

  const fallback = Object.values(resolvedInputs).find((value) => Array.isArray(value));
  if (Array.isArray(fallback)) {
    return fallback;
  }

  throw new Error("control.loop for-each mode requires an array input");
}

function mapInvokeEventToRunEvent(nodeId: string, emit: (event: RunEvent) => void) {
  return (event: InvokeEvent): void => {
    if (event.kind === "token") {
      emit({ kind: "node_token", nodeId, text: event.text });
      return;
    }

    if (event.kind === "tool_call") {
      emit({
        kind: "node_token",
        nodeId,
        text: `\n[tool_call] ${JSON.stringify({ name: event.name, args: event.args })}`,
      });
      return;
    }

    if (event.kind === "tool_result") {
      emit({
        kind: "node_token",
        nodeId,
        text: `\n[tool_result] ${JSON.stringify({ name: event.name, result: event.result })}`,
      });
    }
  };
}

async function invokeAgentStream(
  node: FlowNode,
  resolvedInputs: Record<string, unknown>,
  emit: (event: RunEvent) => void,
  runtime: RuntimeSession,
  flow: LoomFlow,
): Promise<unknown> {
  const adapter = runtimeAdapters.find((candidate) => candidate.supports(node.type));
  if (!adapter) {
    throw new Error(`No runtime adapter for ${node.type}`);
  }

  const mcps = await buildAgentMcps(node, flow, runtime);
  let finalOutput: unknown;
  for await (const event of adapter.invoke({ node, resolvedInputs, runtime, mcps })) {
    if (event.kind === "token") {
      emit({ kind: "node_token", nodeId: node.id, text: event.text });
    } else if (event.kind === "tool_call") {
      emit({ kind: "node_token", nodeId: node.id, text: `\n[tool_call] ${JSON.stringify({ name: event.name, args: event.args })}` });
    } else if (event.kind === "tool_result") {
      emit({ kind: "node_token", nodeId: node.id, text: `\n[tool_result] ${JSON.stringify({ name: event.name, result: event.result })}` });
    } else if (event.kind === "error") {
      throw event.error;
    } else if (event.kind === "final") {
      finalOutput = event.output;
    }
  }

  return finalOutput;
}

async function executeMcpServer(
  node: FlowNode,
  runtime: RuntimeSession,
): Promise<unknown> {
  const options = getMcpClientOptions(node);
  const handle = await getOrCreateMcpServer(runtime, node.id, options);
  return {
    serverInfo: { command: options.command, args: options.args ?? [] },
    tools: handle.tools,
    toolCount: handle.tools.length,
  };
}

async function executeBuiltinNode(node: FlowNode, resolvedInputs: Record<string, unknown>): Promise<unknown> {
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
    default:
      throw new Error(`Node type ${node.type} is not supported in this slice`);
  }
}

export async function loadFlow(flowPath: string): Promise<LoomFlow> {
  const absolutePath = path.resolve(workspaceRoot, flowPath);
  const raw = await readFile(absolutePath, "utf8");
  const flow = flowSchema.parse(YAML.parse(raw));
  const validationErrors = validateFlow(flow);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }
  return flow;
}

export async function* streamRunFlow(
  flowPath: string,
  requestedInputs: Record<string, unknown>,
): AsyncGenerator<RunEvent, void, undefined> {
  const flow = await loadFlow(flowPath);
  const orderedNodes = topologicalSort(flow.nodes);
  const graph = buildNodeGraph(flow.nodes);
  const orderedIndex = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const runId = randomUUID();
  const values = new Map<string, unknown>();
  const nodeResults: RunNodeResult[] = [];
  const nodeResultIndex = new Map<string, number>();
  const nodeStatus = new Map<string, { startedAt: string; finishedAt: string; completionOrder: number }>();
  const completedNodes = new Set<string>();
  const activeNodes = new Set<string>();
  const inFlightNodes = new Map<string, Promise<unknown>>();
  const bufferedEvents: RunEvent[] = [];
  let completionCounter = 0;
  const runtime = new RunnerRuntimeSession();

  const emit = (event: RunEvent): void => {
    bufferedEvents.push(event);
  };

  const flushEvents = async function* (): AsyncGenerator<RunEvent, void, undefined> {
    while (bufferedEvents.length > 0) {
      yield bufferedEvents.shift()!;
    }
  };

  const resolveNodeInputs = (node: FlowNode): Record<string, unknown> => Object.fromEntries(
    Object.entries(node.inputs).map(([key, reference]) => [
      key,
      resolveReference(reference.from, requestedInputs, values) ?? reference.fallback,
    ]),
  );

  const upsertNodeResult = (nodeId: string, output: unknown, startedAt?: string, finishedAt?: string): void => {
    const result: RunNodeResult = { nodeId, output, startedAt, finishedAt };
    const existingIndex = nodeResultIndex.get(nodeId);
    if (existingIndex !== undefined) {
      nodeResults[existingIndex] = result;
      return;
    }

    nodeResultIndex.set(nodeId, nodeResults.length);
    nodeResults.push(result);
  };

  const getOrderedDependents = (nodeId: string): FlowNode[] => {
    const dependentIds = graph.dependents.get(nodeId) ?? [];
    return dependentIds
      .map((dependentId) => graph.nodeMap.get(dependentId))
      .filter((candidate): candidate is FlowNode => candidate !== undefined)
      .sort((left, right) => (orderedIndex.get(left.id) ?? 0) - (orderedIndex.get(right.id) ?? 0));
  };

  const executeSimpleNode = async (node: FlowNode, resolvedInputs: Record<string, unknown>): Promise<unknown> => {
    if (node.type === "agent.claude" || node.type === "agent.litellm") {
      const finalOutput = await invokeAgentStream(node, resolvedInputs, emit, runtime, flow);
      return { output: finalOutput };
    }

    if (node.type === "mcp.server") {
      return executeMcpServer(node, runtime);
    }

    const extendedOutput = await executeExtendedNode({
      node,
      resolvedInputs,
      runtime,
      onEvent: mapInvokeEventToRunEvent(node.id, emit),
    });
    if (extendedOutput !== undefined) {
      return extendedOutput;
    }

    if (node.type === "io.input") {
      return Object.fromEntries(flow.inputs.map((input) => [input.id, requestedInputs[input.id]]));
    }

    return executeBuiltinNode(node, resolvedInputs);
  };

  const executeNodeById = async (nodeId: string, options?: { force?: boolean }): Promise<unknown> => {
    const node = graph.nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`Unknown node ${nodeId}`);
    }

    if (!options?.force) {
      if (completedNodes.has(nodeId)) {
        return values.get(nodeId);
      }

      const inFlight = inFlightNodes.get(nodeId);
      if (inFlight) {
        return inFlight;
      }
    }

    const task = (async () => {
      for (const dependencyId of graph.dependencies.get(nodeId) ?? []) {
        if (activeNodes.has(dependencyId)) {
          continue;
        }
        if (!completedNodes.has(dependencyId)) {
          await executeNodeById(dependencyId);
        }
      }

      if (!options?.force && completedNodes.has(nodeId)) {
        return values.get(nodeId);
      }

      if (node.when && !evaluateWhen(node.when, values)) {
        completedNodes.add(nodeId);
        emit({ kind: "node_skipped", nodeId: node.id });
        return undefined;
      }

      const startedAt = new Date().toISOString();
      activeNodes.add(nodeId);
      emit({ kind: "node_start", nodeId: node.id, type: node.type });

      try {
        const resolvedInputs = resolveNodeInputs(node);
        let output: unknown;

        if (node.type === "control.loop") {
          const config = getControlLoopConfig(node);
          const bodyNodes = getOrderedDependents(node.id);
          const iterations: Array<Record<string, unknown>> = [];
          let lastOutputs: Record<string, unknown> | null = null;
          let maxReached = false;

          const runIteration = async (iteration: number, item: unknown): Promise<void> => {
            values.set(node.id, buildControlLoopIterationValue(resolvedInputs, iteration, item, lastOutputs));
            emit({ kind: "loop_iteration_start", nodeId: node.id, iteration, item });

            const branchResults: ControlBranchResult[] = [];
            for (const bodyNode of bodyNodes) {
              const bodyOutput = await executeNodeById(bodyNode.id, { force: true });
              const status = nodeStatus.get(bodyNode.id);
              branchResults.push({
                nodeId: bodyNode.id,
                output: bodyOutput,
                startedAt: status?.startedAt,
                finishedAt: status?.finishedAt,
                completionOrder: status?.completionOrder,
              });
            }

            const outputsByNode = Object.fromEntries(branchResults.map((result) => [result.nodeId, result.output]));
            const snapshot = {
              iteration,
              item,
              outputs: outputsByNode,
              branches: branchResults,
            } satisfies Record<string, unknown>;

            lastOutputs = outputsByNode as Record<string, unknown>;
            iterations.push(snapshot);
            emit({ kind: "loop_iteration_complete", nodeId: node.id, iteration, output: snapshot });
          };

          if (config.mode === "for-each") {
            const items = getLoopItems(resolvedInputs);
            for (let iteration = 0; iteration < items.length; iteration += 1) {
              if (iteration >= config.max) {
                maxReached = true;
                emit({
                  kind: "node_warning",
                  nodeId: node.id,
                  message: `control.loop exceeded max iterations (${config.max})`,
                });
                break;
              }

              await runIteration(iteration, items[iteration]);
            }
          } else {
            let iteration = 0;
            while (evaluateLoopCondition(config.condition!, resolvedInputs, iteration, lastOutputs)) {
              if (iteration >= config.max) {
                maxReached = true;
                emit({
                  kind: "node_warning",
                  nodeId: node.id,
                  message: `control.loop exceeded max iterations (${config.max})`,
                });
                break;
              }

              await runIteration(iteration, undefined);
              iteration += 1;
            }
          }

          output = buildControlLoopOutput(node, iterations, maxReached);
        } else if (node.type === "control.parallel") {
          values.set(node.id, buildControlParallelOutput(resolvedInputs, []));
          const branchNodes = getOrderedDependents(node.id);
          const branchResults = await Promise.all(branchNodes.map(async (branchNode) => {
            const branchOutput = await executeNodeById(branchNode.id);
            const status = nodeStatus.get(branchNode.id);
            return {
              nodeId: branchNode.id,
              output: branchOutput,
              startedAt: status?.startedAt,
              finishedAt: status?.finishedAt,
              completionOrder: status?.completionOrder,
            } satisfies ControlBranchResult;
          }));
          output = buildControlParallelOutput(resolvedInputs, branchResults);
        } else if (node.type === "control.join") {
          const entries: ControlJoinEntry[] = Object.entries(node.inputs).map(([inputName, reference]) => {
            const upstreamNodeId = getReferenceNodeIds(reference.from)[0];
            const status = upstreamNodeId ? nodeStatus.get(upstreamNodeId) : undefined;
            return {
              inputName,
              nodeId: upstreamNodeId,
              output: resolvedInputs[inputName],
              startedAt: status?.startedAt,
              finishedAt: status?.finishedAt,
              completionOrder: status?.completionOrder,
            };
          });
          output = buildControlJoinOutput(node, entries);
        } else {
          output = await executeSimpleNode(node, resolvedInputs);
        }

        const finishedAt = new Date().toISOString();
        values.set(node.id, output);
        completionCounter += 1;
        nodeStatus.set(node.id, { startedAt, finishedAt, completionOrder: completionCounter });
        upsertNodeResult(node.id, output, startedAt, finishedAt);
        completedNodes.add(node.id);
        emit({ kind: "node_complete", nodeId: node.id, output, meta: buildNodeMeta(node, output) });
        return output;
      } catch (error) {
        if (error instanceof NodeExecutionFailure) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        emit({ kind: "node_error", nodeId: node.id, message });
        throw new NodeExecutionFailure(node.id, message);
      } finally {
        activeNodes.delete(nodeId);
      }
    })();

    if (!options?.force) {
      inFlightNodes.set(nodeId, task);
    }

    try {
      return await task;
    } finally {
      if (!options?.force) {
        inFlightNodes.delete(nodeId);
      }
    }
  };

  yield { kind: "run_start", runId, flowName: flow.name };

  try {
    for (const node of orderedNodes) {
      if (completedNodes.has(node.id)) {
        continue;
      }

      await executeNodeById(node.id);
      yield* flushEvents();
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

    emit({
      kind: "run_complete",
      runId,
      flowName: flow.name,
      outputs,
      nodeResults,
    });
    yield* flushEvents();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ kind: "run_error", runId, message });
    yield* flushEvents();
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(message);
  } finally {
    await runtime.cleanup();
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
