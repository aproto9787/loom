import type { Edge, Node } from "reactflow";
import type { AgentConfig } from "@aproto9787/heddle-core";

export interface GraphPayload {
  nodes: Node[];
  edges: Edge[];
}

const H_SPACING = 260;
const V_SPACING = 120;

interface TreeLayoutResult {
  nodes: Node[];
  edges: Edge[];
  width: number;
}

function layoutAgent(
  agent: AgentConfig,
  path: string[],
  x: number,
  y: number,
): TreeLayoutResult {
  const nodeId = path.join("/");
  const typeLabel = agent.type === "claude-code" ? "CC" : "CX";
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const children = agent.agents ?? [];

  if (children.length === 0) {
    nodes.push({
      id: nodeId,
      type: "default",
      position: { x, y },
      data: { label: `${agent.name}\n[${typeLabel}]`, agentPath: path },
      className: `heddle-agent heddle-agent--${agent.type}`,
      style: { whiteSpace: "pre-line", lineHeight: 1.25 },
    });
    return { nodes, edges, width: 1 };
  }

  // Recursively layout children
  const childResults: TreeLayoutResult[] = [];
  let totalChildWidth = 0;
  for (const child of children) {
    const childPath = [...path, child.name];
    const result = layoutAgent(child, childPath, 0, 0);
    childResults.push(result);
    totalChildWidth += result.width;
  }

  // Position children side by side
  const totalPixelWidth = totalChildWidth * H_SPACING;
  let childX = x - totalPixelWidth / 2 + H_SPACING / 2;
  const childY = y + V_SPACING;

  for (let i = 0; i < children.length; i++) {
    const result = childResults[i];
    const childCenter = childX + (result.width - 1) * H_SPACING / 2;
    const offsetX = childCenter;
    const offsetY = childY;

    // Re-layout with correct positions
    const childPath = [...path, children[i].name];
    const positioned = layoutAgent(children[i], childPath, offsetX, offsetY);
    nodes.push(...positioned.nodes);
    edges.push(...positioned.edges);

    // Edge from parent to child
    edges.push({
      id: `${nodeId}->${childPath.join("/")}`,
      source: nodeId,
      target: childPath.join("/"),
      animated: false,
      style: { stroke: "#94a3b8", strokeWidth: 1.5 },
    });

    childX += result.width * H_SPACING;
  }

  // Add parent node centered above children
  nodes.push({
    id: nodeId,
    type: "default",
    position: { x, y },
    data: { label: `${agent.name}\n[${typeLabel}]`, agentPath: path },
    className: `heddle-agent heddle-agent--${agent.type}`,
    style: { whiteSpace: "pre-line", lineHeight: 1.25 },
  });

  return { nodes, edges, width: Math.max(totalChildWidth, 1) };
}

export function agentTreeToGraph(orchestrator: AgentConfig): GraphPayload {
  const rootPath = [orchestrator.name];
  const result = layoutAgent(orchestrator, rootPath, 400, 40);
  return { nodes: result.nodes, edges: result.edges };
}
