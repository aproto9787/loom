# Loom

> **A visual agent harness. Drag-and-drop. Multi-runtime. Condition-aware.**

Loom is a local-first visual orchestrator for AI agents. You build workflows by dragging nodes onto a canvas, connecting them with typed edges, and running the graph. Token streams flow along the edges in real time while live meters on every node show cost, latency, and throughput as it happens.

Think ComfyUI, but for agents. Or Figma, but for Claude and Codex sessions.

---

## Features

- **Recursive Agent Trees.** Each flow runs through one orchestrator agent that can delegate to nested child agents, record per-agent outputs, and stream the full run lifecycle back to the studio.
- **Runtime Neutral.** Claude Code CLI sessions and Codex CLI sessions coexist in the same flow, and the runner keeps their execution contract behind one adapter interface.
- **Scoped MCP Access.** MCP servers are selected per flow or per agent. Loom writes a throwaway `.mcp.json` per run so each agent only sees the servers it was granted.
- **Agent Isolation.** Agents can opt into `isolated: true`, which gives the spawned CLI process a temporary HOME and prevents accidental reuse of the user's default Claude/Codex home state.
- **Capabilities + Roles.** Agents advertise free-form capabilities for delegation, and role YAML files can supply default type, model, system, effort, capabilities, and isolation that individual agents inherit or override.
- **Run Replay.** When a run finishes, a timeline scrubber lets you rewind the canvas to any point. Click any node to see exactly what it received and produced at that moment.
- **Git-Friendly Storage.** Flows remain plain YAML files, while roles, hooks, and skills also live as local files under the workspace for reviewable changes.

---

## Quickstart

```bash
npx loom
```

This launches the Loom server and opens the studio in your default browser at `http://localhost:5173`.

Or install globally:

```bash
npm install -g loom
loom                    # open the current directory as a workspace
loom ./my-project       # open a specific directory
```

### Your first flow in 30 seconds

1. Open the Workflow tab and start from the default orchestrator agent.
2. Add a child agent in the inspector and choose `claude-code` or `codex`.
3. Give that child a short system prompt plus optional `capabilities` like `frontend` or `review`.
4. Toggle `Isolated` if the child should run with a temporary HOME.
5. Hit **Run**, type a prompt, and watch delegation plus token streaming in the chat transcript.

---

## Core Concepts

Loom now centers on recursive agent orchestration rather than DAG nodes.

```
Flow           A YAML document with one orchestrator agent at the root
 ├─ repo       Working tree shared by the run
 ├─ resources  Flow-wide MCP / hook / skill grants
 └─ orchestrator
     └─ Agent  claude-code or codex, optionally with child agents

Role           Reusable YAML defaults for agent type/model/system/
               effort/capabilities/isolation

Run            One execution of the agent tree
 ├─ Events     run_start / agent_start / token / delegate / complete / error
 ├─ Results    Per-agent outputs with timestamps
 └─ Trace      Persisted run summary in SQLite
```

### Agent Fields

| Field | Purpose |
|---|---|
| `type` | Selects the runtime adapter (`claude-code` or `codex`) |
| `system` | Base instruction block for the agent |
| `capabilities` | Free-form labels surfaced to parent delegation prompts |
| `isolated` | Runs the CLI with a temporary HOME when enabled |
| `mcps` / `hooks` / `skills` | Agent-local resource grants merged with flow-level resources |
| `agents` | Child agents available for delegation |
| `role` | Reference to a role YAML whose defaults are merged into the agent |

---

## Flow Schema

`flow.yaml` is a plain, human-readable recursive agent definition. This is a real working shape from the current runtime.

```yaml
version: "1"
name: Single Repo Agent Orchestration
description: Multiple specialists collaborate inside one shared repository root.
repo: ..
orchestrator:
  name: coordinator
  type: claude-code
  system: You coordinate implementation across one repository.
  agents:
    - name: api
      type: codex
      isolated: true
      capabilities: ["api", "backend", "database"]
      system: You own the API service repository.
    - name: ui
      type: claude-code
      isolated: true
      capabilities: ["frontend", "react", "ux"]
      system: You own the UI repository.
    - name: shared
      type: codex
      capabilities: ["shared-types", "contracts", "refactors"]
      system: You maintain shared types and contracts.
```

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                Studio (React + Vite)                │
│  ┌────────────────────────────────────────────────┐ │
│  │ Workflow tab  │ Chat transcript │ Roles tab    │ │
│  │ Agent editor  │ Run stream      │ Role editor  │ │
│  └────────────────────────────────────────────────┘ │
│                    ▲ HTTP + SSE                      │
└────────────────────┼─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│           apps/server (Fastify + TypeScript)         │
│                                                      │
│  index.ts                  REST + SSE endpoints      │
│  runner.ts                 loadFlow() + exports      │
│  runner-executor.ts        executeAgent/runFlow      │
│  runner-prompt-builder.ts  role merge + prompts      │
│  runner-resource-loader.ts scoped MCP/hook/skill set │
│  trace-store.ts            SQLite run persistence    │
│                                                      │
│                    ▼ adapter spawn                   │
│              claude-code CLI / codex CLI             │
└──────────────────────────────────────────────────────┘
```

### Runtime Adapter Interface

The current runtime is centered on CLI-backed agent adapters.

```ts
interface AgentConfig {
  name: string;
  type: "claude-code" | "codex";
  role?: string;
  model?: string;
  system?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  isolated?: boolean;
  capabilities?: string[];
  mcps?: string[];
  hooks?: string[];
  skills?: string[];
  agents?: AgentConfig[];
}
```

### Execution Model

- `loadFlow()` parses a recursive `FlowDefinition` from YAML and validates it before execution starts.
- `executeAgent()` builds the effective agent config, runs hooks, streams adapter tokens, and records `RunAgentResult` timestamps.
- Child delegation is runtime-driven: parent prompts include child names, descriptions, and capabilities, and the runner can fan out to siblings when the adapter emits a parallel delegation directive.
- `isolated: true` creates a temporary HOME for the spawned CLI process, while `createScopedMcpConfig()` writes a temporary `.mcp.json` containing only the MCP servers granted to that agent.
- Role defaults are loaded from `roles/*.yaml` on each run and merged into agents before execution; explicit agent fields still win when both values are present.

---

## The Live Canvas

The studio is now organized around orchestration, execution, and role authoring.

**Workflow editing.** The workflow tab lets you configure the orchestrator and nested child agents, including role assignment, capabilities, isolation, and scoped MCP / hook / skill resources.

**Live transcript.** Runs stream `agent_start`, token, delegate, complete, timeout, abort, and error events into the chat transcript so you can see delegation decisions as they happen.

**Role authoring.** The Roles tab edits reusable role YAML files that the runner loads on every run.

---

## Roadmap

| Release | Scope |
|---|---|
| **v0.1** | Canvas editing, `claude-api` + `litellm` adapters, token stream animation, code routers, MCP nodes, SQLite traces |
| **v0.2** | `claude-code` + `codex` session adapters, LLM classifier router, loop / parallel / join control nodes, run replay timeline, memento memory adapter |
| **v0.3** | Studio Assistant (AI-powered graph editing), built-in template gallery, converter node library |
| **v0.4** | Node authoring SDK, MCP marketplace integration, plugin system |
| **v1.0** | Remote execution, team workspaces, optional auth |

---

## Tech Stack

**Frontend.** React 19, TypeScript, Vite, Zustand.

**Backend.** Node.js 20+, TypeScript, Fastify, `node:sqlite`, `zod`, `yaml`.

**Adapters.** Claude Code CLI wrapper and Codex CLI wrapper, both supporting temporary HOME isolation and scoped MCP config injection.

**Protocol.** Local MCP server discovery via generated `.mcp.json` files and workspace role/hook/skill YAML definitions.

Loom does not use Electron. It runs as a local HTTP server and opens your default browser.

---

## Project Structure

```
loom/
├── apps/
│   ├── studio/              Frontend (Vite + React + React Flow)
│   │   └── src/{app-shell, chat, roles, workflow}
│   └── server/              Backend (Fastify + TypeScript)
│       └── src/{index, runner, runner-executor, runner-prompt-builder, runner-resource-loader, trace-store}
├── packages/
│   ├── core/                Shared recursive flow schema, roles, run events
│   ├── adapters/            {claude-code, codex} runtime adapters
│   └── nodes/               Flow validation helpers
├── roles/                   Reusable role defaults (YAML)
├── hooks/                   Hook definitions (YAML)
├── skills/                  Skill definitions (YAML)
├── examples/                Ready-to-run recursive agent flows
└── docs/                    Architecture and progress notes
```

Monorepo managed by pnpm workspaces.

---

## Design Decisions

These are the non-obvious calls Loom makes. Knowing them up front will save you time.

- **Node.js, not Python.** The runtime is Node because both supported agent runtimes are local CLIs that are easy to spawn and supervise from one Fastify process.
- **Recursive trees, not DAG wiring.** Loom now treats orchestration as a parent/child agent tree. Delegation is explicit and capability-driven instead of being modeled as graph edges.
- **flow.yaml is still the source of truth.** The studio edits YAML-backed state; roles, hooks, and skills are also plain workspace files.
- **Run-scoped sessions.** Claude Code and Codex subprocesses live for exactly one run. Isolation is optional per agent, but cleanup is always automatic.
- **Least-visible resources by default.** MCP access is rebuilt per agent from flow and agent grants, and isolated agents intentionally skip the user's global Claude config.
- **Local-first, always.** Loom never phones home. No telemetry, no login, no cloud sync.
- **No Electron.** A local HTTP server plus the user's browser keeps startup and updates simple.

---

## Prior Art

- [dance-of-tal/dot-studio](https://github.com/dance-of-tal/dot-studio) — Figma-style editor for OpenCode agents. Shaped our canvas direction.
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — the gold standard for node-based editors.
- [React Flow](https://reactflow.dev) — the canvas library Loom is built on.
- [LangGraph](https://github.com/langchain-ai/langgraph) — an execution model reference for stateful graphs.
- [LiteLLM](https://github.com/BerriAI/litellm) — the universal model proxy Loom ships with.
- [Model Context Protocol](https://modelcontextprotocol.io) — the tool protocol for agents.

---

## License

MIT
