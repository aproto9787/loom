# Risk-Tiered Governance

This folder collects the implementation notes and smoke path for Heddle's Codex-only risk-tiered governance work.

Read in this order:

1. [`STATUS.md`](./STATUS.md) - current branch/worktree state and implemented surface.
2. [`smoke-flow.md`](./smoke-flow.md) - manual governance event smoke path.
3. [`risk-tier-workflow.md`](./risk-tier-workflow.md) - tier definitions, required gates, and failure rules.
4. [`implementation-roadmap.md`](./implementation-roadmap.md) - original phased implementation plan.
5. [`improvement-spec.md`](./improvement-spec.md) - product direction and scope background.
6. [`image-set/`](./image-set/) - visual explanation assets for the proposal.

Core direction:

- Keep Tier A work fast and direct.
- Add contract and review gates for code/schema/runtime changes.
- Require explicit approval and rollback notes for side effects.
- Persist gate records and run manifests so Studio can explain why a run passed, failed, or stopped.
- Expose governance writes through MCP tools, not ad hoc CLI-only state.
- Reject Tier C+ side-effect gate pass until approval and rollback evidence exist.
