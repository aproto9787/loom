import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHeadlessPrompt, buildInteractiveCodexAgentsMd } from "./session-prompts.js";

test("buildHeadlessPrompt combines Loom instructions and the user task", () => {
  const prompt = buildHeadlessPrompt("delegate via loom-subagent", "inspect the repo");

  assert.match(prompt, /# Loom instructions\ndelegate via loom-subagent/);
  assert.match(prompt, /# User task\ninspect the repo/);
});

test("buildInteractiveCodexAgentsMd combines global AGENTS and Loom flow instructions", () => {
  const prompt = buildInteractiveCodexAgentsMd("# Global Rules\nUse Korean.", "Subagent Delegation Protocol");

  assert.match(prompt, /^# Global Rules\nUse Korean\./);
  assert.match(prompt, /# Loom flow instructions\nSubagent Delegation Protocol/);
  assert.match(prompt, /Keep these Loom instructions active for the whole session\./);
  assert.match(prompt, /Wait for the user's next task before doing any work\./);
});

test("buildInteractiveCodexAgentsMd still writes bootstrap without optional inputs", () => {
  assert.match(buildInteractiveCodexAgentsMd(undefined, "  \n "), /# Loom interactive session bootstrap/);
});
