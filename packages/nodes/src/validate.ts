import type { FlowNode, LoomFlow } from "@loom/core";

export interface NodeGraph {
  nodeMap: Map<string, FlowNode>;
  dependencies: Map<string, string[]>;
  dependents: Map<string, string[]>;
}

export interface ControlLoopConfig {
  mode: "while" | "for-each";
  max: number;
  condition?: string;
}

export interface ControlJoinConfig {
  mode: "all" | "any" | "race";
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function getReferenceNodeIds(reference: string): string[] {
  return reference
    .split(" || ")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0 && !candidate.startsWith("$inputs."))
    .map((candidate) => candidate.split(".")[0]!)
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

export function buildNodeDependencies(node: FlowNode): string[] {
  return [...new Set(Object.values(node.inputs).flatMap((input) => getReferenceNodeIds(input.from)))];
}

export function buildNodeGraph(nodes: FlowNode[]): NodeGraph {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const deps = buildNodeDependencies(node);
    dependencies.set(node.id, deps);

    for (const dependency of deps) {
      const group = dependents.get(dependency) ?? [];
      group.push(node.id);
      dependents.set(dependency, group);
    }
  }

  return { nodeMap, dependencies, dependents };
}

export function getControlLoopConfig(node: FlowNode): ControlLoopConfig {
  const mode = node.config.mode;
  if (mode !== "while" && mode !== "for-each") {
    throw new Error("control.loop requires config.mode to be one of while|for-each");
  }

  const max = node.config.max === undefined ? 100 : parsePositiveInteger(node.config.max);
  if (max === undefined) {
    throw new Error("control.loop config.max must be a positive integer when provided");
  }

  const condition = hasNonEmptyString(node.config.condition) ? node.config.condition : undefined;
  if (mode === "while" && !condition) {
    throw new Error("control.loop while mode requires config.condition");
  }

  return { mode, max, condition };
}

export function getControlJoinConfig(node: FlowNode): ControlJoinConfig {
  const mode = node.config.mode;
  if (mode !== "all" && mode !== "any" && mode !== "race") {
    throw new Error("control.join requires config.mode to be one of all|any|race");
  }

  return { mode };
}

export function validateNode(node: FlowNode, graph?: NodeGraph): string[] {
  const errors: string[] = [];

  switch (node.type) {
    case "agent.claude-code":
    case "agent.codex":
      if (node.config.cwd !== undefined && !hasNonEmptyString(node.config.cwd)) {
        errors.push(`${node.type} config.cwd must be a non-empty string when provided`);
      }
      if (node.config.model !== undefined && !hasNonEmptyString(node.config.model)) {
        errors.push(`${node.type} config.model must be a non-empty string when provided`);
      }
      if (node.config.system !== undefined && !hasNonEmptyString(node.config.system)) {
        errors.push(`${node.type} config.system must be a non-empty string when provided`);
      }
      break;

    case "router.llm":
      if (!hasNonEmptyString(node.config.system)) {
        errors.push("router.llm requires config.system");
      }
      if (!hasNonEmptyString(node.config.model)) {
        errors.push("router.llm requires config.model");
      }
      if (!Array.isArray(node.branches) || node.branches.length === 0) {
        errors.push("router.llm requires branches[]");
      }
      break;

    case "control.loop": {
      try {
        getControlLoopConfig(node);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      break;
    }

    case "control.parallel": {
      const downstreamCount = graph?.dependents.get(node.id)?.length ?? 0;
      if (downstreamCount < 2) {
        errors.push("control.parallel requires at least 2 downstream connections");
      }
      break;
    }

    case "control.join": {
      try {
        getControlJoinConfig(node);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      const upstreamCount = graph?.dependencies.get(node.id)?.length ?? 0;
      if (upstreamCount < 2) {
        errors.push("control.join requires at least 2 upstream connections");
      }
      break;
    }

    case "memory.memento":
      if (!hasNonEmptyString(node.config.command)) {
        errors.push("memory.memento requires config.command");
      }
      if (!["remember", "recall", "forget"].includes(String(node.config.operation ?? ""))) {
        errors.push("memory.memento requires config.operation to be one of remember|recall|forget");
      }
      if (node.config.cwd !== undefined && !hasNonEmptyString(node.config.cwd)) {
        errors.push("memory.memento config.cwd must be a non-empty string when provided");
      }
      break;

    default:
      break;
  }

  return errors;
}

export function validateFlow(flow: Pick<LoomFlow, "nodes">): string[] {
  const graph = buildNodeGraph(flow.nodes);
  return flow.nodes.flatMap((node) => validateNode(node, graph).map((message) => `[${node.id}] ${message}`));
}
