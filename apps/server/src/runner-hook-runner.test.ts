import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "@loom/core";
import { runHooks } from "./runner-hook-runner.js";
import type { RunResources } from "./runner-resource-loader.js";

test("runHooks executes matching hooks and ignores missing ones", async () => {
  const originalEnv = process.env.LOOM_HOOK_RUNNER_TEST;
  const agent: AgentConfig = {
    name: "lead",
    type: "claude-code",
    hooks: ["start", "missing"],
  };
  const resources: RunResources = {
    roles: new Map(),
    hooks: new Map([
      ["start", { name: "start", event: "on_start", command: `node -e "if (process.env.LOOM_AGENT === 'lead' && process.env.LOOM_CUSTOM === 'ok') process.exit(0); process.exit(1)"` }],
    ]),
    skills: new Map(),
  };

  try {
    await runHooks(agent, "on_start", resources, { LOOM_CUSTOM: "ok" });
    assert.equal(process.env.LOOM_HOOK_RUNNER_TEST, originalEnv);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.LOOM_HOOK_RUNNER_TEST;
    } else {
      process.env.LOOM_HOOK_RUNNER_TEST = originalEnv;
    }
  }
});

test("runHooks swallows hook failures after logging them", async () => {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const agent: AgentConfig = {
      name: "lead",
      type: "claude-code",
      hooks: ["broken"],
    };
    const resources: RunResources = {
      roles: new Map(),
      hooks: new Map([
        ["broken", { name: "broken", event: "on_start", command: "node -e \"process.exit(9)\"" }],
      ]),
      skills: new Map(),
    };

    await runHooks(agent, "on_start", resources, {});
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /Hook execution failed for broken/);
  } finally {
    console.error = originalError;
  }
});
