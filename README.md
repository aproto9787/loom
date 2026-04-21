# Loom

> Local, YAML-backed orchestration for Claude Code and Codex CLI agents.

Loom is an experimental local agent runner. A flow is a plain YAML file with one root `orchestrator` agent and optional nested child agents. The server validates and stores flows, runs and run events. The studio edits/observes those flows in the browser. The CLI can launch a flow's root agent and uses `loom-subagent` for recursive child-agent execution.

This README describes the code on the current `master` branch. It intentionally avoids claims that are not represented in the current TypeScript schema or runtime.

## Current status

Implemented today:

- Recursive agent-tree flow schema with `claude-code` and `codex` agent types.
- Fastify server for flow CRUD, run history, run event ingestion, role/hook/skill CRUD, MCP/resource discovery, and SSE streams.
- React/Vite studio that talks to the local server.
- CLI binaries: `loom`, `loom-subagent`, and legacy `loom-conductor`.
- Adapter layer for Claude Code CLI and Codex CLI.
- SQLite-backed run and event persistence under `.loom/traces.db`.
- Flow-level and agent-level resource names for MCPs, hooks, and skills.
- Role YAML defaults for `type`, `model`, `system`, `effort`, `description`, and `mcps`.

Not represented in the current schema/runtime:

- DAG node editing, typed edge execution, node routers, loop/join nodes, or cost/latency meters.
- `capabilities` and `isolated` fields on `AgentConfig` or `RoleDefinition`.
- Published-package quickstart guarantees for `npx loom` or `npm install -g loom`.
- Automated golden-path verification for full leader → conductor → worker recursion.

## Repository layout

```text
loom/
├── apps/
│   ├── server/       Fastify API, flow validation, legacy server runner, traces
│   └── studio/       React 19 + Vite studio
├── packages/
│   ├── core/         Zod schemas and shared run/flow types
│   ├── adapters/     Claude Code and Codex CLI adapters
│   ├── cli/          loom, loom-subagent, loom-conductor binaries
│   └── nodes/        Flow validation helpers
├── examples/         Flow YAML files shown by the server/studio
├── roles/            Reusable role YAML definitions
├── hooks/            Hook YAML definitions
├── skills/           Skill YAML definitions
└── docs/             Architecture and code-backed state notes
```

## Develop from source

Loom is a pnpm workspace. Use Node.js 20+.

```bash
pnpm install
pnpm -r build
```

Run the local server and studio in separate terminals:

```bash
pnpm --filter @loom/server dev
pnpm --filter @loom/studio dev
```

Defaults:

- Server: `http://localhost:8787`
- Studio: `http://localhost:5173`

The root script also exists:

```bash
pnpm dev
```

## CLI usage from a built checkout

Build the server and CLI first because the CLI currently imports built server modules from `apps/server/dist`:

```bash
pnpm --filter @loom/server build
pnpm --filter loom build
node packages/cli/dist/index.js
```

The `loom` binary scans the current directory and `examples/` for `.yaml` flows, lets you pick one interactively, then launches the selected flow's root orchestrator.

The `loom-subagent` binary is the current generalized child-agent launcher:

```bash
node packages/cli/dist/subagent-launcher.js \
  --name reviewer \
  --backend codex \
  --parent leader \
  "Review the changed files and write a short report."
```

`loom-conductor` is kept for compatibility with older prompts and is superseded by `loom-subagent` for new work.

## Flow schema

The source of truth is `packages/core/src/index.ts`. A flow has this shape:

```ts
interface FlowDefinition {
  version?: string;
  name: string;
  description?: string;
  repo: string;
  claudeMd?: string;
  claudeMdLibrary?: Record<string, string>;
  teams?: TeamDefinition[];
  orchestrator: AgentConfig;
  resources?: {
    mcps?: string[];
    hooks?: string[];
    skills?: string[];
  };
}
```

An agent has this shape:

```ts
interface AgentConfig {
  name: string;
  type: "claude-code" | "codex";
  role?: string;
  team?: Array<{ id: string; role?: string }>;
  model?: string;
  system?: string;
  claudeMdRef?: string;
  description?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  timeout?: number;
  parallel?: boolean;
  delegation?: Array<{ to: string; when: string }>;
  mcps?: string[];
  hooks?: string[];
  skills?: string[];
  agents?: AgentConfig[];
}
```

A role has this shape:

```ts
interface RoleDefinition {
  name: string;
  type: "claude-code" | "codex";
  model?: string;
  system: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  description?: string;
  mcps?: string[];
}
```

Hook definitions:

```ts
type HookEvent = "on_start" | "on_complete" | "on_error" | "on_delegate";

interface HookDefinition {
  name: string;
  event: HookEvent;
  command: string;
  description?: string;
}
```

Skill definitions:

```ts
interface SkillDefinition {
  name: string;
  prompt: string;
  description?: string;
}
```

## Minimal flow example

```yaml
version: "1"
name: Review Flow
description: A leader delegates a focused review task.
repo: .
resources:
  skills:
    - concise
teams:
  - id: review
    description: Review and validation work.
orchestrator:
  name: leader
  type: claude-code
  model: claude-opus-4-7
  system: |
    You coordinate the work and delegate review tasks when needed.
  effort: high
  delegation:
    - to: reviewer
      when: Code or documentation needs a second pass.
  agents:
    - name: reviewer
      type: codex
      role: code-reviewer
      team:
        - id: review
          role: reviewer
      model: gpt-5.4
      system: |
        Review the assigned work and report concrete findings.
      timeout: 600000
      skills:
        - concise
```

## Server API surface

The server is local-first and permissive for development CORS. Important routes:

- `GET /health`
- `GET /flows`
- `GET /flows/get?path=examples/<file>.yaml`
- `PUT /flows/save`
- `POST /flows/new`
- `POST /flows/duplicate`
- `DELETE /flows/:path`
- `POST /runs`
- `POST /runs/stream`
- `GET /runs`
- `GET /runs/:id`
- `POST /runs/:id/abort`
- `POST /runs/register`
- `POST /runs/:id/events`
- `GET /runs/:id/events`
- `GET /runs/:id/stream`
- `PATCH /runs/:id/status`
- `GET /mcps`
- `GET /discover`
- `GET /roles`, `GET /roles/:name`, `PUT /roles/save`, `DELETE /roles/:name`
- `GET /hooks`, `PUT /hooks/save`, `DELETE /hooks/:name`
- `GET /skills`, `PUT /skills/save`, `DELETE /skills/:name`

Flow paths accepted by server run/save/get routes must stay under `examples/` and end in `.yaml`.

## Runtime paths

There are two runtime paths in the code right now.

### CLI path

`packages/cli/src/index.ts` launches the selected flow's root orchestrator. The root agent receives a generated delegation prompt that tells it to call child agents through Bash using `loom-subagent`. Child agents post their events back to the server with `runId`, `agentName`, `agentDepth`, `parentAgent`, and `agentKind` metadata.

This is the path new recursive child-agent work should target.

### Server runner path

`apps/server/src/runner-executor.ts` still powers `POST /runs` and `POST /runs/stream`, including the Studio save→run path. That file is marked deprecated in code and should not receive new runtime behavior except while the Studio remains wired to it.

## Resource model

Loom has three workspace resource directories:

- `roles/*.yaml`
- `hooks/*.yaml`
- `skills/*.yaml`

Flow-level resources are merged with agent-level resources by name. Skills are appended to prompts. Hooks are executed by the server runner using `child_process.exec` with a 30-second timeout. MCP names are resolved from the user's Claude config and workspace `.mcp.json`; selected MCP servers are written into a temporary `.mcp.json` for a run.

## Security notes

Loom executes local CLI tools and hook commands from your machine. Treat flow, role, hook, and skill files as trusted code/configuration.

Current code paths include powerful flags:

- Claude Code adapter uses `--permission-mode bypassPermissions`.
- Codex adapter uses `--dangerously-bypass-approvals-and-sandbox`.
- CLI launch also uses dangerous permission/sandbox bypass flags for root agents.
- Hooks run shell commands through `child_process.exec`.

Use Loom only inside repositories and workspaces you trust.

## Design direction

The current code is closer to a local recursive agent harness than a general visual DAG builder. The most important next cleanup is to collapse the split runtime story: keep the CLI/`loom-subagent` path as the primary runtime, then rewire Studio run actions to that path or a shared runtime package.

## License

MIT
