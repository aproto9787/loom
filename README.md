# Loom

> Local, YAML-backed orchestration for Claude Code and Codex CLI agents.

[![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue.svg)](LICENSE)
![Node 22+](https://img.shields.io/badge/Node-22%2B-339933.svg?logo=node.js&logoColor=white)
![pnpm workspace](https://img.shields.io/badge/pnpm-workspace-F69220.svg?logo=pnpm&logoColor=white)
![Status experimental](https://img.shields.io/badge/status-experimental-orange.svg)

Loom is an experimental local agent runner. A flow is a plain YAML file with one root `orchestrator` agent and optional nested child agents. The server validates and stores flows, runs and run events. The studio edits/observes those flows in the browser. The CLI can launch a flow's root agent and uses `loom-subagent` for recursive child-agent execution.

This README describes the code on the current `master` branch. It intentionally avoids claims that are not represented in the current TypeScript schema or runtime.

## Table of Contents

- [Current status](#current-status)
- [Repository layout](#repository-layout)
- [Quickstart](#quickstart)
- [Develop from source](#develop-from-source)
- [CLI usage from a built checkout](#cli-usage-from-a-built-checkout)
- [Flow schema](#flow-schema)
- [Minimal flow example](#minimal-flow-example)
- [Server API surface](#server-api-surface)
- [Runtime paths](#runtime-paths)
- [Resource model](#resource-model)
- [Security notes](#security-notes)
- [Design direction](#design-direction)
- [License](#license)

## Current status

Implemented today:

- Recursive agent-tree flow schema with `claude-code` and `codex` agent types.
- Fastify server for flow CRUD, run history, run event ingestion, role/hook/skill CRUD, MCP/resource discovery, local CLI run spawning, and SSE streams.
- React/Vite studio that talks to the local server.
- CLI binaries: `loom` and `loom-subagent`.
- - SQLite-backed run and event persistence under `.loom/traces.db`.
- Flow-level and agent-level resource names for MCPs, hooks, and skills.
- Role YAML defaults for `type`, `model`, `system`, `effort`, `description`, and `mcps`.

Not represented in the current schema/runtime:

- DAG node editing, typed edge execution, node routers, loop/join nodes, or cost/latency meters.
- `capabilities` and `isolated` fields on `AgentConfig` or `RoleDefinition`.
- Published-package quickstart guarantees for `npx loom` or `npm install -g loom`.
- Automated golden-path verification for full leader → worker recursion.

## Repository layout

```text
loom/
├── apps/
│   ├── server/       Fastify API, flow validation, local CLI runner and traces
│   └── studio/       React 19 + Vite studio
├── packages/
│   ├── core/         Zod schemas and shared run/flow types
│   ├── cli/          loom and loom-subagent binaries
│   └── runtime/      Shared flow loading, resources, prompts, and hooks
├── examples/         Flow YAML files shown by the server/studio
├── roles/            Reusable role YAML definitions
├── hooks/            Hook YAML definitions
├── skills/           Skill YAML definitions
└── docs/             Architecture and code-backed state notes
```

## Quickstart

```bash
pnpm install
pnpm -r build
pnpm --filter @loom/server dev
pnpm --filter @loom/studio dev
```

## Develop from source

Loom is a pnpm workspace. Use Node.js 22.13+; the local trace store uses `node:sqlite`.

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

Build the CLI from the workspace. The CLI now imports shared helpers from `@loom/runtime` instead of built server modules:

```bash
pnpm --filter loom build
node packages/cli/dist/index.js
```

The `loom` binary scans the current directory and `examples/` for `.yaml` flows, lets you pick one interactively, then launches the selected flow's root orchestrator. For local-server initiated runs, the same binary also supports a headless mode:

```bash
node packages/cli/dist/index.js \
  --flow examples/leader-workers.yaml \
  --prompt "Review this workspace and delegate as needed." \
  --headless
```

The `loom-subagent` binary is the generalized child-agent launcher:

```bash
node packages/cli/dist/subagent-launcher.js \
  --name reviewer \
  --backend codex \
  --parent leader \
  "Review the changed files and write a short report."
```


## Flow schema

The source of truth is `packages/core/src/index.ts`. A flow has this shape:

```ts
interface FlowDefinition {
  version?: string;
  name: string;
  description?: string;
  repo: string;
  flowMd?: string;
  flowMdLibrary?: Record<string, string>;
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
  flowMdRef?: string;
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
      model: gpt-5.5
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
- `POST /runs` (creates a run record and starts the local CLI headless path)
- `POST /runs + GET /runs/:id/stream` (compatibility SSE wrapper over the local CLI path)
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

The CLI/`loom-subagent` path is now the primary local execution path.

### CLI path

`packages/cli/src/index.ts` launches the selected flow's root orchestrator. The root agent receives a generated delegation prompt that tells it to call child agents through Bash using `loom-subagent`. Child agents post their events back to the server with `runId`, `agentName`, `agentDepth`, `parentAgent`, and `agentKind` metadata.

This is the path new recursive child-agent work should target.

### Local server run path

`apps/server/src/local-cli-runner.ts` still powers `POST /runs` and including the Studio save→run path. That file is marked deprecated in code and should not receive new runtime behavior except while the Studio remains wired to it.

## Resource model

Loom has three workspace resource directories:

- `roles/*.yaml`
- `hooks/*.yaml`
- `skills/*.yaml`

Flow-level resources are merged with agent-level resources by name. Skills are appended to prompts. Hooks are executed by the server runner using `child_process.exec` with a 30-second timeout. MCP names are resolved from the user's Claude config and workspace `.mcp.json`; selected MCP servers are written into a temporary `.mcp.json` for a run.

> [!WARNING]
> Review the security notes below before running Loom. The current code can launch local CLI tools and shell hooks with dangerous permission and sandbox bypass flags.

## Security notes

Loom executes local CLI tools and hook commands from your machine. Treat flow, role, hook, and skill files as trusted code/configuration.

Current code paths include powerful flags:

- Claude Code adapter uses `--permission-mode bypassPermissions`.
- Codex adapter uses `--dangerously-bypass-approvals-and-sandbox`.
- CLI launch also uses dangerous permission/sandbox bypass flags for root agents.
- Hooks run shell commands through `child_process.exec`.

Use Loom only inside repositories and workspaces you trust.

## Design direction

The current code is closer to a local recursive agent harness than a general visual DAG builder. The most important cleanup now is smaller: keep the local CLI path boring and reliable, then reduce or remove the legacy in-process server runner once nothing imports it.

## License

Copyright (C) 2026 aproto9787

Loom is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3.

Loom is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for the full terms.
