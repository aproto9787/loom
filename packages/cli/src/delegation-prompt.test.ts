import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "@aproto9787/heddle-core";
import { buildDelegationPrompt } from "./delegation-prompt.js";

test("buildDelegationPrompt contains only Heddle delegation guidance", () => {
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
  assert.match(prompt, /heddle_delegate/);
  assert.match(prompt, /\*\*reviewer\*\*/);
  assert.doesNotMatch(prompt, /Oracle/);
  assert.doesNotMatch(prompt, /heddle_oracle/);
});
