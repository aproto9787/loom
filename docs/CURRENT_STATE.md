# Current code-backed state

This note is the short, code-backed baseline for Loom's current implementation. It is meant to keep README and architecture claims honest while the project continues to change quickly.

## Current source of truth

The active schema lives in `packages/core/src/index.ts`.

Supported agent types:

- `claude-code`
- `codex`

Current `AgentConfig` fields:

- `name`
- `type`
- `role`
- `team`
- `model`
- `system`
- `claudeMdRef`
- `description`
- `effort`
- `timeout`
- `parallel`
- `delegation`
- `mcps`
- `hooks`
- `skills`
- `agents`

Current `RoleDefinition` fields:

- `name`
- `type`
- `model`
- `system`
- `effort`
- `description`
- `mcps`

## Claims that should not be made yet

Do not document these as implemented unless the code changes first:

- `isolated` field in flow YAML.
- `capabilities` field in flow or role YAML.
- Cost, latency, throughput, or token-meter UI.
- DAG node execution, typed edge routing, loop/join/control nodes, or general graph runtime.
- Guaranteed `npx loom` / global npm install flow.
- Automated golden-path test coverage for leader → conductor → workers.

## What is implemented

- A recursive agent-tree YAML schema.
- `examples/`-scoped flow CRUD and validation.
- Server run routes that create local run records and spawn the built `loom` CLI in `--headless` mode.
- CLI-launched runs with event registration and persisted event streaming.
- `@loom/runtime` as the shared home for flow loading, resource loading, prompt building, scoped MCP config generation, and hook execution.
- `loom-subagent` as the generalized child-agent launcher.
- Claude Code and Codex CLI adapters.
- Role/hook/skill YAML CRUD.
- MCP/resource discovery and selected MCP config generation.
- SQLite run/event persistence under `.loom/traces.db`.

## Active runtime split

New subagent behavior still belongs in `packages/cli/src/subagent-launcher.ts`.

Shared flow/resource/prompt/hook helpers now live in `packages/runtime`. Server/studio run routes now go through the local CLI path. `apps/server/src/local-cli-runner.ts` remains in the tree as a legacy compatibility path, not as the place for new runtime behavior.

## Safe wording for docs

Use wording like:

> Loom currently runs recursive YAML-defined agent trees using Claude Code and Codex CLI processes.

Avoid wording like:

> Drag and drop typed edges, run graphs, and watch cost/latency meters.

That may still be a product direction, but it is not the current code-backed implementation.
