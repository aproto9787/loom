import assert from "node:assert/strict";
import { test } from "node:test";
import {
  flowDefinitionSchema,
  gateRecordSchema,
  governanceConfigSchema,
  migrateLegacyFlowDefinitionInput,
  migrateLegacyRoleDefinitionInput,
  runManifestSchema,
} from "./index.js";

test("flow schema accepts existing flows without governance", () => {
  const parsed = flowDefinitionSchema.safeParse({
    version: "1",
    name: "Existing Flow",
    repo: ".",
    orchestrator: {
      name: "leader",
      type: "codex",
      system: "Lead the work.",
    },
  });

  assert.equal(parsed.success, true);
});

test("active flow schema rejects unmigrated legacy agent types", () => {
  const parsed = flowDefinitionSchema.safeParse({
    version: "1",
    name: "Legacy Flow",
    repo: ".",
    orchestrator: {
      name: "leader",
      type: "claude-code",
    },
  });

  assert.equal(parsed.success, false);
});

test("governance config validates default packs", () => {
  const parsed = governanceConfigSchema.safeParse({
    defaultTier: "quick",
    defaultPack: "code-change-default",
    packs: {
      "code-change-default": {
        tier: "code",
        requiredGates: ["acceptance", "contract", "codex-reviewer"],
        optionalGates: ["user-advocate"],
        description: "Default code-change governance pack.",
      },
    },
  });

  assert.equal(parsed.success, true);
});

test("legacy claude-code flow input migrates to codex with explicit notes", () => {
  const migrated = migrateLegacyFlowDefinitionInput({
    version: "1",
    name: "Legacy Flow",
    repo: ".",
    orchestrator: {
      name: "leader",
      type: "claude-code",
      runtime: {
        profile: "claude-default",
      },
      model: "claude-opus-4-7",
      agents: [
        {
          name: "reviewer",
          type: "claude-code",
          model: "claude-sonnet-4-6",
        },
      ],
    },
  });

  const parsed = flowDefinitionSchema.safeParse(migrated.value);
  const migratedFlow = migrated.value as {
    orchestrator: {
      type: string;
      runtime: { profile: string };
      model: string;
      agents: Array<{ type: string; model: string }>;
    };
  };

  assert.equal(migrated.changed, true);
  assert.equal(parsed.success, true);
  assert.equal(migratedFlow.orchestrator.type, "codex");
  assert.equal(migratedFlow.orchestrator.runtime.profile, "codex-default");
  assert.equal(migratedFlow.orchestrator.model, "gpt-5.5");
  assert.equal(migratedFlow.orchestrator.agents[0]?.type, "codex");
  assert.equal(migratedFlow.orchestrator.agents[0]?.model, "gpt-5.5");
  assert.deepEqual(
    migrated.notes.map((note) => [note.path, note.from, note.to]),
    [
      ["orchestrator.type", "claude-code", "codex"],
      ["orchestrator.runtime.profile", "claude-default", "codex-default"],
      ["orchestrator.model", "claude-opus-4-7", "gpt-5.5"],
      ["orchestrator.agents.0.type", "claude-code", "codex"],
      ["orchestrator.agents.0.model", "claude-sonnet-4-6", "gpt-5.5"],
    ],
  );
  assert.match(migrated.notes[0]?.message ?? "", /converted to codex/);
});

test("legacy claude-code roles migrate to codex with explicit notes", () => {
  const migrated = migrateLegacyRoleDefinitionInput({
    name: "legacy-reviewer",
    type: "claude-code",
    model: "claude-sonnet-4-6",
    system: "Review the work.",
  });

  assert.equal(migrated.changed, true);
  assert.deepEqual(
    migrated.notes.map((note) => [note.path, note.from, note.to]),
    [
      ["role.type", "claude-code", "codex"],
      ["role.model", "claude-sonnet-4-6", "gpt-5.5"],
    ],
  );
});

test("gate records require a reason for the selected status", () => {
  const parsed = gateRecordSchema.safeParse({
    gate: "codex-reviewer",
    status: "pass",
    reason: "No behavior regression found.",
    evidence: ["packages/core/src/index.ts:155"],
  });

  assert.equal(parsed.success, true);
});

test("run manifests connect tiers, gates, approvals, and rollback records", () => {
  const parsed = runManifestSchema.safeParse({
    runId: "run-1",
    request: "Change a production setting.",
    interpretedGoal: "Prepare a Tier C guarded settings change.",
    riskTier: "side_effect",
    governancePack: "side-effect-default",
    workers: ["codex-analyst-1"],
    gates: [
      {
        gate: "side-effect-approval",
        status: "blocked",
        reason: "Approval and rollback are required before execution.",
        blockers: ["approval-missing", "rollback-missing"],
      },
    ],
    approvals: [
      {
        id: "approval-1",
        gate: "side-effect-approval",
        status: "required",
        target: "production-setting",
        reason: "Side effect requires explicit user approval.",
      },
    ],
    rollbacks: [
      {
        id: "rollback-1",
        gate: "side-effect-approval",
        status: "planned",
        target: "production-setting",
        rollbackPlan: "Restore the previous setting value.",
      },
    ],
    result: "blocked",
  });

  assert.equal(parsed.success, true);
});
