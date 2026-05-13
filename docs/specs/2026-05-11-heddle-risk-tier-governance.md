# Heddle Codex-Only Risk-Tier Governance Product Completion

## Source Request

User invoked `$interview-heddle` for the current `feat/risk-tier-governance` worktree and clarified that the target is not a reduced MVP/V1. The target is a product-complete branch implementation, executed in phases, using `/goal` and Heddle workers after the spec is ready.

After Phase 1 exposed a Claude Code authentication blocker for `user-advocate`, the user redirected the product direction: Heddle should remove/exclude Claude as part of this plan, not merely work around the blocker. The completed product should be Codex-only.

## Goal

Implement a Codex-only Heddle runtime and risk-tiered governance as real Heddle product capabilities on the `feat/risk-tier-governance` branch only.

When complete, Heddle no longer depends on Claude Code in the product/runtime/default flow surface. Existing `claude-code` flow YAML is migrated to Codex with explicit migration notes. A Heddle run can then classify work by risk tier, select governance gates, record gate/approval/rollback state, enforce Tier C+ side-effect boundaries, expose the governance state through MCP tools, persist it in the existing run trace model, and show it in Studio run detail.

## Current Context

- The active worktree is `/home/argoss/asos/dev/worktrees/heddle-risk-tier` on branch `feat/risk-tier-governance`.
- The stable main checkout `/home/argoss/asos/dev/Project/heddle` must remain untouched.
- Existing design notes live under `docs/risk-tier-governance/`.
- Current Heddle schema source is `packages/core/src/index.ts`.
- Current run event intake and SSE routes live in `apps/server/src/index.ts`.
- Current run persistence lives in `apps/server/src/trace-store.ts`.
- Current Studio run-detail data types and fetch/stream logic live in `apps/studio/src/store.ts`.
- Current Studio run detail rendering lives in `apps/studio/src/AppSections.tsx`.
- Current MCP delegation tool surface lives in `packages/mcp/src/tools.ts` and `packages/mcp/src/server.ts`.
- Current default flow policy lives in `examples/leader-workers.yaml`.
- Current code still contains Claude provider/runtime/docs/UI surfaces that must be removed or migrated as part of this plan.

## Scope

- Remove Claude Code from Heddle's active product/runtime/default flow surface:
  - schema/provider type surface
  - adapters/runtime launch path
  - default example flow roles
  - Studio provider labels and configuration surfaces
  - README/current-state/product docs
- Convert existing `claude-code` flow YAML to Codex automatically at load/save boundaries, and emit a clear migration note instead of silently changing semantics.
- Replace Claude-backed default roles with Codex-backed roles:
  - `user-advocate`
  - debaters
  - synthesizer
  - frontend specialist
- Add core schema and TypeScript types for:
  - `RiskTier`
  - `GovernancePack`
  - `GateStatus`
  - `GateRecord`
  - `RunManifest`
  - approval and rollback records needed for Tier C+ side-effect gating
- Extend the existing trace/run model instead of creating a separate product silo.
- Persist first-class governance events:
  - `gate_record`
  - `manifest_update`
  - `approval_required`
  - `approval_recorded`
  - `rollback_recorded`
- Add MCP governance tools:
  - `heddle_record_gate`
  - `heddle_read_manifest`
  - `heddle_update_manifest`
  - `heddle_require_approval`
  - `heddle_record_approval`
  - `heddle_record_rollback`
- Enforce Tier C+ side-effect safety by preventing side-effect gate pass until approval and rollback records exist.
- Update `examples/leader-workers.yaml` so the default leader policy is Codex-only and uses risk-tier governance without slowing low-risk work.
- Add Studio run-detail UI for:
  - risk tier badge
  - governance pack
  - gate timeline
  - selected gate detail
  - approval/rollback panel
  - manifest summary
- Update docs and examples so the branch is PR-ready and implementation claims match code.
- Keep the existing low-risk direct workflow fast.

## Non-Goals

- Do not touch `/home/argoss/asos/dev/Project/heddle`.
- Do not keep Claude as a hidden default, fallback, or preferred worker backend.
- Do not require the user's Claude auth for Heddle worker execution, review, user-advocate validation, Studio use, or smoke verification.
- Do not silently convert `claude-code` flows without a migration note.
- Do not add compliance registry, RACI, cost tracking, backup/DR, feature flags, canary flow automation, or external deployment automation.
- Do not turn Heddle into a generic enterprise SDLC template engine.
- Do not require reviewer/user-advocate gates for every low-risk task.
- Do not perform real side effects such as deletion, deployment, account change, payment, or real trading during verification.
- Do not silently downgrade enforcement to documentation-only behavior.

## Decisions

- The branch target is product-complete implementation, not MVP/V1.
- Work proceeds in phases, but each phase must leave tested, usable behavior before the next phase starts.
- Heddle becomes Codex-only in active product/runtime/default flow surfaces.
- Existing `claude-code` flow YAML should be converted to Codex automatically, but the migration must be explicit and visible.
- `user-advocate` remains part of phase validation, but it must become Codex-backed.
- Tier C+ side-effect work requires explicit approval and rollback memo before the side-effect gate can pass.
- Gate and manifest state should extend the current `.heddle/traces.db` run/event model.
- The manifest summary may be assembled from run metadata and governance events unless a separate table becomes strictly necessary.
- Studio run detail is the primary user-visible product surface.
- Final branch state should be PR-ready. Commit, push, or PR creation require separate user direction.

## Phases

### Phase 0: Codex-Only Migration

Acceptance:

- [ ] `claude-code` is removed from active provider/runtime/default flow surfaces.
- [ ] Existing `claude-code` flow YAML loads through an explicit migration path to `codex`.
- [ ] Migration notes are visible to CLI/server/Studio users when a legacy flow is converted.
- [ ] Default roles and default `examples/leader-workers.yaml` are Codex-backed, including `user-advocate`, debaters, synthesizer, and frontend specialist.
- [ ] Heddle worker validation does not require Claude auth.
- [ ] Product docs describe Heddle as Codex-only and do not advertise Claude-backed execution.
- [ ] Any remaining `claude`/`claude-code` strings are limited to migration notes, changelog/history, or tests proving legacy conversion.

### Phase 1: Schema and Contracts

Acceptance:

- [ ] Core exports typed schemas for risk tiers, governance packs, gate records, approval records, rollback records, and run manifests.
- [ ] Existing non-Claude flow YAML remains valid when governance is omitted.
- [ ] Legacy `claude-code` flow YAML can be migrated to Codex through the agreed conversion path.
- [ ] `examples/leader-workers.yaml` can opt into governance defaults.
- [ ] Unit coverage or flow-load validation proves backward compatibility.

### Phase 2: Trace and Server Persistence

Acceptance:

- [ ] Server accepts and validates governance event payloads.
- [ ] Trace store persists governance events with enough raw detail to reconstruct a manifest.
- [ ] `GET /runs/:id/events` returns governance events.
- [ ] SSE streams governance events to Studio subscribers.
- [ ] Server tests cover valid and invalid governance event paths.

### Phase 3: MCP Governance Tools

Acceptance:

- [ ] Heddle MCP lists the governance tools in addition to delegation tools.
- [ ] `heddle_record_gate` records typed gate results.
- [ ] `heddle_read_manifest` reconstructs current governance state for the run.
- [ ] `heddle_update_manifest` records bounded manifest updates.
- [ ] `heddle_require_approval` records pending approval state.
- [ ] `heddle_record_approval` and `heddle_record_rollback` record the explicit evidence needed for Tier C+ gates.
- [ ] MCP tests cover valid calls and rejected invalid calls.

### Phase 4: Runtime Enforcement

Acceptance:

- [ ] Tier C+ side-effect gate cannot pass without both approval and rollback records.
- [ ] The failure reason is explicit and visible through manifest/gate state.
- [ ] Low-risk Tier A work remains direct and does not require heavy governance gates.
- [ ] Worker/report completion rules still reject `running` status as completion.

### Phase 5: Studio Product UI

Acceptance:

- [ ] Run detail shows risk tier badge and governance pack when present.
- [ ] Gate timeline is visible and scannable.
- [ ] Selecting a gate shows status, reason, evidence, and blocker details.
- [ ] Approval and rollback records are visible for Tier C+ flows.
- [ ] Manifest summary explains the current run governance state.
- [ ] Runs without governance events keep the existing UI behavior.

### Phase 6: Docs, Examples, and Smoke Flow

Acceptance:

- [ ] `docs/risk-tier-governance/` matches implemented behavior and no longer overclaims.
- [ ] A source-controlled example or scripted smoke path demonstrates governance events.
- [ ] Existing product docs remain honest about implemented vs target behavior.
- [ ] Image/generator docs are either made reproducible or clearly documented.

### Phase 7: Final Review, Fix, and Usable Verification

Acceptance:

- [ ] Heddle worker reports have been integrated.
- [ ] `codex-reviewer` passes for non-trivial code/schema/runtime changes.
- [ ] Codex-backed `user-advocate` passes for product-goal alignment and no goal shrinking.
- [ ] Build, tests, typecheck, and diff checks pass.
- [ ] Heddle server and Studio are launched from this branch.
- [ ] A sample run or equivalent seeded run shows governance state in Studio.

## Acceptance Criteria

- [ ] Heddle's active runtime and default flows are Codex-only.
- [ ] Legacy `claude-code` flow YAML is converted to Codex with an explicit migration note.
- [ ] Existing non-Claude Heddle flows without governance config still load and run.
- [ ] Default `leader-workers` policy uses Codex-backed risk-tier governance.
- [ ] Governance records are typed, persisted, streamed, and visible.
- [ ] Tier C+ side-effect gates are blocked until approval and rollback records exist.
- [ ] MCP governance tools are discoverable and usable from a Heddle leader session.
- [ ] Studio gives a clear product experience for risk tier, gate status, approval, rollback, and manifest state.
- [ ] Low-risk work is not slowed by enterprise-only gates.
- [ ] Docs and examples match the implemented product.
- [ ] Main checkout remains untouched.

## Implementation Boundaries

- Target area:
  - `packages/core/src/index.ts`
  - `packages/adapters/src/**`
  - `packages/runtime/src/**`
  - `packages/cli/src/**`
  - `apps/server/src/index.ts`
  - `apps/server/src/trace-store.ts`
  - `apps/server/src/*.test.ts`
  - `packages/mcp/src/*.ts`
  - `packages/mcp/src/*.test.ts`
  - `apps/studio/src/store.ts`
  - `apps/studio/src/AppSections.tsx`
  - `apps/studio/src/*.test.ts`
  - `examples/leader-workers.yaml`
  - `roles/*.yaml`
  - `docs/risk-tier-governance/`
  - `README.md`
  - `docs/CURRENT_STATE.md`
  - `docs/LOCAL_AGENT_CONTROL_PLANE.md`
  - `docs/specs/`
- Preserve:
  - Existing Heddle delegation tool contracts.
  - Existing run history and SSE behavior for non-governance runs.
  - Existing local-first runtime model.
  - Existing low-risk direct execution default.
  - Main checkout `/home/argoss/asos/dev/Project/heddle`.

## Verification Plan

- `pnpm -r build` should pass.
- `pnpm -r test` should pass.
- `pnpm -r typecheck` should pass.
- `git diff --check` should pass.
- Legacy `claude-code` flow fixture should convert to Codex and surface a migration note.
- Default Heddle flow should run with Codex-backed leader/workers only.
- `user-advocate` should run as a Codex-backed worker.
- MCP initialize/tool list should include delegation and governance tools.
- A valid governance tool call should persist a governance event.
- Invalid Tier C+ side-effect pass without approval and rollback should fail.
- `GET /runs/:id/events` should return governance events.
- Heddle server and Studio should launch from this worktree.
- Studio run detail should display a seeded or sample run with risk tier, gate timeline, approval/rollback state, and manifest summary.
- Product/runtime grep should show no active Claude execution surface. Remaining Claude strings must be migration/history/test-only and documented as such.

## Open Questions

- None.

## Goal Handoff

Implement this spec exactly: `docs/specs/2026-05-11-heddle-risk-tier-governance.md`.

Treat the spec and active goal as the source of truth. Keep scope limited to the acceptance criteria and implementation boundaries. Use Codex-backed Heddle workers for phase implementation, review, fix, and user-advocate validation. Verify with the listed verification plan. Mark complete only after the result is usable from the user's perspective.
