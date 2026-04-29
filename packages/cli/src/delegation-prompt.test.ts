import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "@aproto9787/loom-core";
import { buildDelegationPrompt } from "./delegation-prompt.js";

test("buildDelegationPrompt frames Oracle as an automatic external advisor for leaders", () => {
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

  assert.match(prompt, /Oracle is available as an external advisor plugin/);
  assert.match(prompt, /check `loom_oracle_status` once and call `loom_oracle`/);
  assert.match(prompt, /Skip Oracle for trivial edits/);
  assert.match(prompt, /Treat Oracle output as advisory evidence/);
});
