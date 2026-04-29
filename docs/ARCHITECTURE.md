# Architecture

This document describes Loom as implemented in the current codebase. It avoids earlier DAG-era and roadmap claims that are not present in the active schemas or runtime.

For the target product/runtime direction, read
[`docs/LOCAL_AGENT_CONTROL_PLANE.md`](LOCAL_AGENT_CONTROL_PLANE.md). That
document is the implementation north star for host leader sessions,
Loom-managed workers, and MCP-based delegation.

## System overview

```text
┌──────────────────────────────────────────────────────────────┐
│ Browser                                                      │
│ apps/studio                                                  │
│ - React 19 + Vite                                            │
│ - Talks to the local Fastify server over HTTP/SSE            │
│ - Edits flows, roles, hooks, and skills through server APIs   │
│ - Displays run history and streamed run events                │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP + SSE
┌──────────────────────────────▼───────────────────────────────┐
│ apps/server                                                   │
│ - Fastify API on PORT=8787 by default                         │
│ - Validates YAML flows with @aproto9787/loom-core                         │
│ - Stores run records/events in .loom/traces.db                 │
│ - Provides CRUD for examples/, roles/, hooks/, skills/         │
│ - Spawns the built `loom` CLI for local runs           │
│ - Receives CLI run events from loom / loom-subagent            │
└─────────────┬───────────────────────────────┬────────────────┘
              │                               │
              │ imports shared packages        │ stores
              │                               │
┌─────────────▼──────────────┐      ┌─────────▼────────────────┐
│ packages/core              │      │ .loom/traces.db           │
│ - Zod flow schema           │      │ - runs                    │
│ - agent/role/hook/skill     │      │ - events                  │
│   definitions               │      │ - node_results            │
│ - run/event TypeScript      │      │   (currently agent result │
│   types                     │      │    rows despite old name) │
└─────────────┬──────────────┘      └──────────────────────────┘
              │
┌─────────────▼──────────────┐
│ packages/adapters           │
│ - claude-code adapter        │
│ - codex adapter              │
│ - delegation protocol parser │
└─────────────┬──────────────┘
              │
┌─────────────▼──────────────┐
│ packages/cli                │
│ - loom                      │
│ - loom mcp                  │
│ - loom-subagent             │
│ - loom-subagent legacy     │
└────────────────────────────┘
```

## Workspace packages

### `packages/core`

Owns the current recursive agent-tree schema:

- `FlowDefinition`
- `AgentConfig`
- `RoleDefinition`
- `HookDefinition`
- `SkillDefinition`
- run request/response, run record, run summary, and run event types

Important current schema facts:

- Agent types are exactly `claude-code` and `codex`.
- `AgentConfig` has `enabled`, `runtime`, `team`, `delegation`, `flowMdRef`, `timeout`, `parallel`, `mcps`, `hooks`, `skills`, and recursive `agents`.
- `AgentConfig` does not currently define `isolated` or `capabilities`.
- `RoleDefinition` currently defines `name`, `type`, `model`, `system`, `effort`, `description`, and `mcps`.
- `RoleDefinition` does not currently define `hooks`, `skills`, `isolated`, or `capabilities`.

### `packages/core`

Currently provides flow validation helpers, not a DAG node runtime. `validateFlow()` checks required flow/agent fields and recursively validates the agent tree.

### `packages/adapters`

Provides the `AgentAdapter` interface and two concrete CLI-backed adapters.

```ts
type AgentEvent =
  | { type: "token"; content: string }
  | { type: "complete"; output: string }
  | { type: "error"; error: string }
  | { type: "delegate"; childAgent: string; reason: string };
```

The adapter registry maps:

- `claude-code` → `claudeCodeAdapter`
- `codex` → `codexAdapter`

Delegation output is parsed in two formats:

```text
DELEGATE <child-name>: <reason>
```

or JSON:

```json
{ "childAgent": "reviewer", "reason": "Review the patch" }
```

Parallel delegation can be emitted as:

```json
{
  "parallel": [
    { "childAgent": "a", "reason": "..." },
    { "childAgent": "b", "reason": "..." }
  ]
}
```

### `packages/cli`

Provides the main CLI plus subcommands/binaries:

- `loom`: interactive flow launcher.
- `loom mcp`: stdio MCP delegation bridge for host leader sessions.
- `loom-subagent`: generalized recursive child-agent launcher for Claude or Codex backends.
- `loom-subagent`: legacy Codex conductor launcher, retained for compatibility.

`loom` currently imports built server modules from `apps/server/dist`, so the server package must be built before running the CLI from source.

`loom-subagent` accepts arguments such as:

```bash
loom-subagent --name reviewer --backend codex --parent leader "briefing text"
```

It posts mapped events to the server when `LOOM_RUN_ID` is present. Events include agent identity and tree metadata:

- `agentName`
- `agentDepth`
- `parentAgent`
- `agentKind`

## Server API

The server is built in `apps/server/src/index.ts`.

### Flow routes

- `GET /flows` lists top-level `.yaml` files under `examples/`.
- `GET /flows/get` reads and validates one example flow.
- `PUT /flows/save` writes a validated flow back under `examples/`.
- `POST /flows/duplicate` copies an existing flow under a generated slug.
- `POST /flows/new` creates a skeleton flow.
- `DELETE /flows/:path` deletes an example flow.

### Plugin routes

- `GET /plugins/oracle/status` checks optional Oracle CLI and MCP availability.
- `POST /plugins/oracle/run` starts an external Oracle advisor plugin run and stores its result as Loom run history.

Flow path validation rejects absolute paths, path escapes outside `examples/`, and non-`.yaml` files.

### Run routes

- `POST /runs` executes through the deprecated server runner and returns a collected response.
- `POST /runs + GET /runs/:id/stream` executes through the deprecated server runner and emits SSE lifecycle events.
- `POST /runs/register` creates a running record for a CLI-launched run.
- `POST /runs/:id/events` appends CLI-launched run events.
- `GET /runs/:id/events` returns stored events.
- `GET /runs/:id/stream` streams newly appended persisted events over SSE.
- `PATCH /runs/:id/status` finalizes a CLI-launched run.
- `GET /runs` and `GET /runs/:id` read run history/details.
- `POST /runs/:id/abort` aborts active server-runner executions only.

### Resource routes

- `GET /mcps` discovers MCP server names from Claude/workspace config.
- `GET /discover` discovers provider profiles plus MCPs, hooks, and skills from Claude, Codex, and Loom workspace locations.
- `GET /roles`, `GET /roles/:name`, `PUT /roles/save`, `DELETE /roles/:name`.
- `GET /hooks`, `PUT /hooks/save`, `DELETE /hooks/:name`.
- `GET /skills`, `PUT /skills/save`, `DELETE /skills/:name`.

## Runtime paths

There are two overlapping run paths.

### 1. CLI / subagent path

This is the newer path.

1. `loom` loads a flow.
2. It builds the configured root agent.
3. It injects a delegation protocol into the root agent prompt.
4. The root agent is spawned as Claude Code or Codex.
5. The root agent receives a temporary Loom MCP server config and must call Loom MCP delegation tools for child work. `loom-subagent` remains the internal worker runtime behind the MCP server.
6. `loom-subagent` maps Claude/Codex stream frames to Loom events.
7. The server stores those events through `/runs/:id/events`.
8. Studio can follow `/runs/:id/stream` for persisted event updates.

### 2. Local server run path

This path remains active for server `POST /runs`, and the current Studio save→run path.

1. Server validates `flowPath` under `examples/`.
2. `loadFlow()` parses YAML through `flowDefinitionSchema` and `validateFlow()`.
3. `streamRunFlow()` creates a run id and execution state.
4. `executeAgent()` spawns the configured adapter, emits `RunEvent`s, and recursively runs child agents on delegation.
5. Run summaries and agent results are stored in `.loom/traces.db`.

`runner-executor.ts` is marked deprecated in its own header. New runtime behavior should target `packages/cli/src/subagent-launcher.ts` or a future shared runtime package instead.

## Prompt and role merging

`buildConfiguredAgent()` applies role defaults and recursively configures child agents.

Merge behavior:

- If `agent.role` exists and a matching role YAML is loaded, role fields are spread first.
- Explicit agent fields win over role fields.
- `system` falls back to the role's `system` when the agent has no `system`.
- `description` falls back to the role's `description` when the agent has no `description`.

The generated agent prompt includes:

- Agent system prompt.
- Selected skills from resolved resources.
- Shared repo path.
- MCP and hook names visible to the agent.
- Child agent list with `name`, `type`, `team`, `delegation`, and description from child `system`.
- Delegation instructions using the `DELEGATE <child>: <reason>` format.

If `agent.parallel` is true and children exist, the prompt also includes the JSON `parallel` delegation format.

## Resource loading

`runner-resource-loader.ts` loads workspace files from:

- `roles/*.yaml`
- `hooks/*.yaml`
- `skills/*.yaml`

`resolveAgentResources()` merges flow-level and agent-level resource name lists.

`createScopedMcpConfig()` reads MCP server definitions from:

- `<home>/.claude.json`
- workspace `.mcp.json`

It writes a temporary `.mcp.json` containing only the selected MCP server names. If no selected servers resolve, no temporary MCP config is returned.

## External advisor plugins

Loom may expose plugins for external advisor CLIs, but those plugins are adapters around user-installed commands, not vendored product features.

The Oracle plugin follows that rule:

- **Oracle by steipete** is an external project and is not copied into Loom.
- Loom does not add `@steipete/oracle` as a required package dependency.
- Oracle-specific code lives in `@aproto9787/loom-plugin-oracle`, not `@aproto9787/loom-runtime` or `@aproto9787/loom-core`.
- `loom_oracle_status` detects `oracle`, `oracle-mcp`, and `npx` on `PATH`.
- `loom_oracle` calls an installed `oracle` command first, then may fall back to `npx -y @steipete/oracle`.
- If Oracle is unavailable, the connector returns an install hint and the rest of Loom continues to work.
- Advisor requests and results are posted as run events when `LOOM_RUN_ID` and `LOOM_SERVER_ORIGIN` are available, so they land in `.loom/traces.db` with the workflow timeline.
- Studio calls the server's Oracle plugin endpoints to run the same external adapter from a UI tab; those UI runs create normal run-history rows with Oracle tool events.

Users who prefer Oracle's own MCP server should install `oracle-mcp` separately and register it in user/workspace MCP config. Loom only scopes that external MCP into the run; it does not embed the Oracle MCP server.

## Persistence

`trace-store.ts` uses Node's `node:sqlite` `DatabaseSync` and stores data in `.loom/traces.db`.

Tables:

- `runs`
- `events`
- `node_results`

The historical `node_results` name is still used, but rows are now interpreted as agent results in the recursive-agent model.

CLI-launched runs are registered, event-appended, and finalized incrementally. Server-runner runs are persisted when the run completes/fails/aborts.

## Security posture

Loom should be treated as a trusted-local-workspace tool.

Current behavior includes:

- Claude Code adapter passes `--permission-mode bypassPermissions`.
- Codex adapter passes `--dangerously-bypass-approvals-and-sandbox` and `--ephemeral`.
- CLI root launch uses dangerous bypass flags for Claude/Codex.
- Hooks execute arbitrary shell commands through `child_process.exec` with the current process environment plus Loom variables.
- CORS is permissive for local development.

Before broader distribution, the project should make trust boundaries explicit in UI and docs, especially around hook execution and permission-bypass CLI flags.

## Known architecture debt

- The CLI imports built files from `apps/server/dist`; shared runtime/load/prompt/resource logic should move into a package.
- `runner-executor.ts` is deprecated but still active for server/studio run routes.
- Schema/docs previously mentioned `isolated` and `capabilities`, but those fields are absent from the current core schema.
- The example set currently centers on `examples/leader-workers.yaml`; smaller onboarding flows would make the project easier to test and explain.
- Golden-path recursive execution is still largely manual; a fake Claude/Codex harness would make it testable without launching real CLIs.
- MCP cancellation is best-effort and currently depends on local process signaling.


## Local execution path

For the source-checkout workflow, the CLI path is the primary runtime:

```text
Studio or API request
  -> apps/server creates a run row
  -> apps/server spawns node packages/cli/dist/index.js --headless
  -> loom launches the root Claude/Codex process
  -> root agents delegate through Loom MCP tools
  -> loom / loom-subagent POST timeline events back to apps/server
  -> apps/server persists events in .loom/traces.db
  -> Studio watches /runs/:id/stream and reads /runs/:id/events
```

The older in-process server executor is kept only as a compatibility module. New local recursive-agent behavior should go into the CLI / loom-subagent path or the small shared helpers in `@aproto9787/loom-runtime`.
