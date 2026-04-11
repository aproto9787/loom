import type { Edge, Node } from "reactflow";
import type { LoomFlow } from "@loom/core";

// Layout a flow's nodes in a simple layered layout based on dependencies.
// This is intentionally minimal — the point is to get a readable graph
// drawn from the YAML without pulling in a full layout engine.
export interface GraphPayload {
  nodes: Node[];
  edges: Edge[];
}

interface LayoutNode {
  id: string;
  column: number;
  row: number;
}

const COLUMN_WIDTH = 240;
const ROW_HEIGHT = 140;

function dependenciesOf(node: LoomFlow["nodes"][number]): string[] {
  const refs = Object.values(node.inputs)
    .map((input) => input.from)
    .filter((from) => !from.startsWith("$inputs."));
  const whenRef = node.when?.split(/\s*==\s*/)[0]?.split(".")[0];
  if (whenRef) {
    refs.push(whenRef);
  }
  return Array.from(new Set(refs.map((ref) => ref.split(".")[0])));
}

function computeLayout(flow: LoomFlow): Map<string, LayoutNode> {
  const depsMap = new Map<string, Set<string>>();
  for (const node of flow.nodes) {
    depsMap.set(node.id, new Set(dependenciesOf(node).filter((id) => flow.nodes.some((n) => n.id === id))));
  }

  const columns = new Map<string, number>();
  const remaining = new Set(flow.nodes.map((n) => n.id));
  let safety = flow.nodes.length * 4;

  while (remaining.size > 0 && safety > 0) {
    safety -= 1;
    for (const id of Array.from(remaining)) {
      const deps = depsMap.get(id) ?? new Set();
      const allResolved = Array.from(deps).every((d) => columns.has(d));
      if (allResolved) {
        const column = deps.size === 0
          ? 0
          : Math.max(...Array.from(deps).map((d) => (columns.get(d) ?? 0) + 1));
        columns.set(id, column);
        remaining.delete(id);
      }
    }
  }
  // Fallback for any nodes stuck in a cycle.
  for (const id of remaining) {
    columns.set(id, 0);
  }

  const rowsByColumn = new Map<number, number>();
  const layout = new Map<string, LayoutNode>();
  for (const node of flow.nodes) {
    const column = columns.get(node.id) ?? 0;
    const row = rowsByColumn.get(column) ?? 0;
    layout.set(node.id, { id: node.id, column, row });
    rowsByColumn.set(column, row + 1);
  }
  return layout;
}

export function flowToGraph(flow: LoomFlow): GraphPayload {
  const layout = computeLayout(flow);

  const nodes: Node[] = flow.nodes.map((node) => {
    const pos = layout.get(node.id);
    return {
      id: node.id,
      type: "default",
      position: {
        x: (pos?.column ?? 0) * COLUMN_WIDTH + 40,
        y: (pos?.row ?? 0) * ROW_HEIGHT + 40,
      },
      data: { label: `${node.id}\n${node.type}` },
      className: `loom-node loom-node--${node.type.replace(/\./g, "-")}`,
      style: { whiteSpace: "pre-line", lineHeight: 1.25 },
    };
  });

  const edges: Edge[] = [];
  for (const node of flow.nodes) {
    for (const dep of dependenciesOf(node)) {
      if (!flow.nodes.some((candidate) => candidate.id === dep)) {
        continue;
      }
      edges.push({
        id: `${dep}->${node.id}`,
        source: dep,
        target: node.id,
        animated: false,
      });
    }
  }

  return { nodes, edges };
}
