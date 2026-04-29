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

test("buildDelegationPrompt respects Oracle advisor flow settings", () => {
  const agent: AgentConfig = {
    name: "leader",
    type: "codex",
    oracleAdvisor: {
      useFor: ["review"],
      skipTrivial: false,
      useNpxFallback: false,
      recordCalls: false,
    },
    agents: [{
      name: "reviewer",
      type: "codex",
      system: "Review implementation patches.",
    }],
  };

  const prompt = buildDelegationPrompt(agent, "leader");

  assert.match(prompt, /non-trivial review decisions/);
  assert.match(prompt, /Pass `useNpxFallback: false`/);
  assert.match(prompt, /Oracle workflow-event recording is disabled/);
  assert.doesNotMatch(prompt, /Skip Oracle for trivial edits/);
});

test("buildDelegationPrompt disables automatic Oracle use when configured off", () => {
  const agent: AgentConfig = {
    name: "leader",
    type: "codex",
    oracleAdvisor: { enabled: false },
    agents: [{
      name: "reviewer",
      type: "codex",
      system: "Review implementation patches.",
    }],
  };

  const prompt = buildDelegationPrompt(agent, "leader");

  assert.match(prompt, /Oracle external advisor auto-use is disabled/);
  assert.doesNotMatch(prompt, /check `loom_oracle_status` once and call `loom_oracle`/);
});
