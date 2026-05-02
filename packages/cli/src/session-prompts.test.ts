import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHeadlessPrompt, buildInteractiveCodexAgentsMd } from "./session-prompts.js";

test("buildHeadlessPrompt combines Heddle instructions and the user task", () => {
  const prompt = buildHeadlessPrompt("delegate via heddle-subagent", "inspect the repo");

  assert.match(prompt, /# Heddle instructions\ndelegate via heddle-subagent/);
  assert.match(prompt, /# User task\ninspect the repo/);
});

test("buildInteractiveCodexAgentsMd combines global AGENTS and Heddle flow instructions", () => {
  const prompt = buildInteractiveCodexAgentsMd("# Global Rules\nUse Korean.", "Subagent Delegation Protocol");

  assert.match(prompt, /^# Global Rules\nUse Korean\./);
  assert.match(prompt, /# Heddle flow instructions\nSubagent Delegation Protocol/);
  assert.match(prompt, /Keep these Heddle instructions active for the whole session\./);
  assert.match(prompt, /Wait for the user's next task before doing any work\./);
});

test("buildInteractiveCodexAgentsMd still writes bootstrap without optional inputs", () => {
  assert.match(buildInteractiveCodexAgentsMd(undefined, "  \n "), /# Heddle interactive session bootstrap/);
});
