# Risk-Tiered Governance Status

## Current State

- Active implementation worktree: `/home/argoss/asos/dev/worktrees/heddle-risk-tier`
- Active branch: `feat/risk-tier-governance`
- Main Heddle checkout remains untouched at `/home/argoss/asos/dev/Project/heddle`.
- Heddle's active product/runtime/default flow surface is Codex-only.
- Legacy `claude-code` YAML is migrated to `codex` at load/save boundaries with visible migration notes.
- Core governance contracts are implemented in `packages/core/src/index.ts`.
- Governance events are persisted through the existing run event path in `apps/server/src/index.ts` and `.heddle/traces.db`.
- MCP governance tools are exposed by `@aproto9787/heddle-mcp`.
- Tier C+ side-effect boundary gates are rejected until approved approval evidence and rollback evidence exist.
- Studio run detail reconstructs and displays governance state from run events.

## Implemented Governance Surface

- Risk tiers: `quick`, `code`, `side_effect`, `enterprise`
- Governance records:
  - `GateRecord`
  - `ApprovalRecord`
  - `RollbackRecord`
  - `RunManifest`
- Persisted event types:
  - `manifest_update`
  - `gate_record`
  - `approval_required`
  - `approval_recorded`
  - `rollback_recorded`
- MCP tools:
  - `heddle_record_gate`
  - `heddle_read_manifest`
  - `heddle_update_manifest`
  - `heddle_require_approval`
  - `heddle_record_approval`
  - `heddle_record_rollback`

## Verification Baseline

Run from `/home/argoss/asos/dev/worktrees/heddle-risk-tier`:

```bash
pnpm -r typecheck
pnpm -r build
pnpm -r test
git diff --check
```

Focused smoke references:

- `apps/server/src/index.test.ts` covers governance event persistence, manifest reconstruction, SSE-compatible run events, and Tier C+ side-effect enforcement.
- `packages/mcp/src/index.test.ts` covers governance tool discovery and tool-to-event posting.
- [`smoke-flow.md`](./smoke-flow.md) shows the manual event path.

## Constraints

- Low-risk work remains direct-first; governance does not force reviewer or advocate gates onto every run.
- Side effects must not be executed from a governance flow before explicit approval and rollback evidence are recorded.
- Enterprise-only project-management surfaces remain out of scope unless implemented in code first.
