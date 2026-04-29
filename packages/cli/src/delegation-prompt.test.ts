import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "@aproto9787/loom-core";
import { buildDelegationPrompt } from "./delegation-prompt.js";

test("buildDelegationPrompt contains only Loom delegation guidance", () => {
  const agent: AgentConfig = {
    name: "leader",
    type: "codex",
    agents: [{
      name: "reviewer",
      type: "codex",
      system: "Review implementation patches.",
    }],
  };

  const prompt = buildDelegationPrompt(agent, "leader");

  assert.match(prompt, /Subagent Delegation Protocol/);
  assert.match(prompt, /loom_delegate/);
  assert.match(prompt, /\*\*reviewer\*\*/);
  assert.doesNotMatch(prompt, /Oracle/);
  assert.doesNotMatch(prompt, /loom_oracle/);
});
