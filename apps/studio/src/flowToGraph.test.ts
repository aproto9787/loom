import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTreeToGraph } from "./flowToGraph.js";

test("agentTreeToGraph builds nodes and edges for nested agents", () => {
  const graph = agentTreeToGraph({
    name: "lead",
    type: "codex",
    agents: [
      { name: "writer", type: "codex" },
      { name: "reviewer", type: "codex" },
    ],
  });

  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  assert.deepEqual(graph.edges.map((edge) => edge.id).sort(), [
    "lead->lead/reviewer",
    "lead->lead/writer",
  ]);
});
