import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentAtPath, useRunStore } from "./store.js";

test("getAgentAtPath resolves nested agents", () => {
  const agent = getAgentAtPath(
    {
      name: "lead",
      type: "claude-code",
      agents: [
        {
          name: "writer",
          type: "claude-code",
          agents: [{ name: "reviewer", type: "codex" }],
        },
      ],
    },
    ["lead", "writer", "reviewer"],
  );

  assert.equal(agent?.name, "reviewer");
  assert.equal(agent?.type, "codex");
});

test("store addAgent and removeAgent update the tree selection", () => {
  useRunStore.setState({
    loadedFlow: {
      name: "demo",
      repo: ".",
      orchestrator: { name: "lead", type: "claude-code", agents: [] },
    },
    flowDraft: {
      name: "demo",
      repo: ".",
      orchestrator: { name: "lead", type: "claude-code", agents: [] },
    },
    selectedAgentPath: ["lead"],
    isDirty: false,
  });

  useRunStore.getState().addAgent(["lead"], "codex");
  let state = useRunStore.getState();
  assert.deepEqual(state.selectedAgentPath, ["lead", "codex-agent-1"]);
  assert.equal(state.flowDraft?.orchestrator.agents?.[0]?.name, "codex-agent-1");

  useRunStore.getState().removeAgent(["lead", "codex-agent-1"]);
  state = useRunStore.getState();
  assert.deepEqual(state.selectedAgentPath, ["lead"]);
  assert.equal(state.flowDraft?.orchestrator.agents?.length, 0);
});
