# Loom

> **A visual agent harness. Drag-and-drop. Multi-runtime. Condition-aware.**

Loom is a local-first visual orchestrator for AI agents. You build workflows by dragging nodes onto a canvas, connecting them with typed edges, and running the graph. Token streams flow along the edges in real time while live meters on every node show cost, latency, and throughput as it happens.

Think ComfyUI, but for agents. Or Figma, but for Claude and Codex sessions.

---

## Features

- **Runtime Neutral.** Claude API calls, Claude Code CLI sessions, Codex CLI sessions, and any model reachable via LiteLLM coexist on the same canvas. Adding a new runtime means implementing one adapter interface.
- **Condition-First Graphs.** Branching is a first-class concept, not an afterthought. Loom ships with code-expression routers, LLM classifier routers, loops, parallel fork/join, and breakpoints.
- **Live Canvas.** Token streams animate along edges while runs are executing. Every node shows a live progress ring, a running token/cost/latency badge, and a thinking bubble with the last tokens it generated.
- **Run Replay.** When a run finishes, a timeline scrubber lets you rewind the canvas to any point. Click any node to see exactly what it received and produced at that moment.
- **MCP Native.** Model Context Protocol servers are first-class nodes. Drop an `mcp.server` node, wire it to an agent node, and that agent gains those tools.
- **Git-Friendly Storage.** Flows are plain `flow.yaml` files. Human-readable, diffable, mergeable, reviewable. The canvas is a view on the file, not the other way around.
- **Local-First.** Loom runs entirely on your machine. No accounts, no cloud, no telemetry. Remote execution is an optional v1.0 feature, never mandatory.

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

1. Double-click the empty canvas → type `claude` → Enter. An `agent.claude` node drops in.
2. Drag from the node's text input port into empty space → release → pick `io.input`.
3. Drag from the node's output port into empty space → release → pick `io.output`.
4. Click the `agent.claude` node → paste your API key in the inspector panel.
5. Hit **Run**, type a prompt, watch tokens stream across the edges.

---

## Core Concepts

Loom's vocabulary is deliberately plain. If you've used any node-based editor, you already know it.

```
Flow      A full graph, persisted to flow.yaml
 ├─ Node  An execution unit (agent / router / control / io / memory / mcp)
 │   └─ Ports  Typed input/output sockets
 ├─ Edge  A typed connection between ports
 └─ Meta  Viewport, layout, annotations

Run       A single execution instance of a flow
 ├─ Events  Per-node lifecycle (start, token, tool_call, complete, error)
 ├─ Values  Snapshot of actual data that flowed across each edge
 └─ Cost    Aggregated token / dollar / latency breakdown
```

### Node Catalog

| Category | Node | Description | Since |
|---|---|---|---|
| **agent** | `agent.claude` | Anthropic API, streaming | v0.1 |
| | `agent.litellm` | Any model via the LiteLLM proxy (OpenAI, Gemini, Ollama, …) | v0.1 |
| | `agent.claude-code` | Claude Code CLI session — real file edits and tool calls | v0.2 |
| | `agent.codex` | Codex CLI session | v0.2 |
| **router** | `router.code` | Branch on a JavaScript expression (`out.score > 0.8`) | v0.1 |
| | `router.llm` | Branch chosen by a small classifier model | v0.2 |
| **control** | `control.loop` | `while` and `for-each` loops | v0.2 |
| | `control.parallel` | Parallel fork | v0.2 |
| | `control.join` | Parallel join (`all` / `any` / `race`) | v0.2 |
| **io** | `io.input` | Prompt the user at the start of a run | v0.1 |
| | `io.output` | Publish the run's final result | v0.1 |
| | `io.file` | Read and write files on disk | v0.1 |
| **memory** | `memory.blackboard` | Shared key-value store, scoped to the run | v0.1 |
| | `memory.memento` | Long-term memory via the memento-mcp adapter | v0.2 |
| **mcp** | `mcp.server` | Mount an MCP server and expose its tools to agent nodes | v0.1 |

### Port Types

| Type | Color | Purpose |
|---|---|---|
| `text` | white | Plain strings |
| `json` | amber | Structured data |
| `file` | blue | File paths |
| `stream` | violet (glowing) | Token streams — the targets of edge animation |
| `control` | gray | Trigger signals, no payload |

Port compatibility is checked at connection time. Incompatible connections are rejected, and Loom suggests inserting a converter node (`text → json`, `json → file`, etc.) when types are close.

---

## Flow Schema

`flow.yaml` is a plain, human-readable specification. This is a real working flow.

```yaml
version: loom/v1
name: Research & Draft
description: Web search → summarize → conditional deep dive → draft

inputs:
  - id: topic
    type: text
    prompt: "Topic to research"

mcps:
  - id: brave-search
    command: npx
    args: ["@modelcontextprotocol/brave-search"]
    env:
      BRAVE_API_KEY: ${env.BRAVE_API_KEY}

nodes:
  - id: search
    type: agent.litellm
    config:
      model: gpt-4o-mini
      system: |
        You are a web search agent. Given a topic, return the five most
        important sources as a JSON array.
    mcps: [brave-search]
    inputs:
      query: { from: $inputs.topic }
    outputs:
      sources: json

  - id: score
    type: router.code
    config:
      expression: sources.length >= 3 ? 'deep' : 'shallow'
    inputs:
      sources: { from: search.sources }
    branches: [deep, shallow]

  - id: deep_research
    type: agent.claude
    config:
      model: claude-opus-4-6
      system: Deep analyst. Verify each source and cross-reference them.
    inputs:
      sources: { from: search.sources }
    when: score.branch == 'deep'

  - id: draft
    type: agent.claude-code
    config:
      cwd: ./workspace
      system: Draft author. Produce draft.md from the analysis.
    inputs:
      analysis:
        from: deep_research.output
        fallback: search.sources

outputs:
  - id: result
    from: draft.output
```

---

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                   Browser (React)                      │
│   ┌────────────────────────────────────────────────┐  │
│   │  Canvas (React Flow)                            │  │
│   │    ├─ Node palette (drag source)                │  │
│   │    ├─ Graph editor with type-aware connections  │  │
│   │    ├─ Live edge animation (token streams)       │  │
│   │    ├─ Node inspector panel                      │  │
│   │    └─ Run timeline with scrubbable replay       │  │
│   └────────────────────────────────────────────────┘  │
│               ▲ WebSocket (SSE for tokens)             │
└───────────────┼────────────────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────┐
│            Loom Server (Node.js + TypeScript)          │
│                                                         │
│   ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│   │ Flow API │  │  Runner  │  │ Trace/Checkpoint │    │
│   │ YAML r/w │  │  (graph  │  │     (SQLite)     │    │
│   └──────────┘  │ executor)│  └──────────────────┘    │
│                 └────┬─────┘                            │
│                      │                                  │
│          ┌───────────┼──────────┬──────────┐           │
│          ▼           ▼          ▼          ▼           │
│   ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐  │
│   │  Claude  │ │  Claude  │ │  Codex │ │ LiteLLM  │  │
│   │   API    │ │   Code   │ │   CLI  │ │  Proxy   │  │
│   │ Adapter  │ │ Adapter  │ │Adapter │ │ Adapter  │  │
│   └──────────┘ └──────────┘ └────────┘ └──────────┘  │
│                      │                                  │
│               ┌──────▼──────┐                           │
│               │  MCP Bridge │  (stdio to MCP servers)   │
│               └─────────────┘                           │
└─────────────────────────────────────────────────────────┘
```

### Runtime Adapter Interface

Every runtime Loom supports implements one interface. This is the extension point.

```ts
interface RuntimeAdapter {
  id: string;                                          // "claude-api" | "claude-code" | "codex" | "litellm"
  validate(config: NodeConfig): Result;
  invoke(ctx: InvokeCtx): AsyncIterable<InvokeEvent>;  // streaming
  cancel(ctx: InvokeCtx): Promise<void>;
  cost(events: InvokeEvent[]): CostBreakdown;
}

type InvokeEvent =
  | { kind: "token", text: string }
  | { kind: "tool_call", name: string, args: unknown }
  | { kind: "tool_result", name: string, result: unknown }
  | { kind: "final", output: unknown }
  | { kind: "error", error: Error };
```

Loom ships with four adapters out of the box: `claude-api`, `claude-code`, `codex`, `litellm`. Each runs in its own worker and emits a unified event stream to the runner.

### Execution Model

- **Stateless nodes** invoke once per run, consuming their inputs and producing outputs.
- **Session nodes** (`agent.claude-code`, `agent.codex`) spawn a long-lived subprocess for the duration of a run. Conversation context is preserved across invocations within the same graph execution. When the run ends, the session terminates.
- **Checkpoints** are committed to SQLite after every node completes. On failure, runs resume from any completed node via *"Continue from here."*
- **Cancellation** is cooperative. Hitting Stop sends cancel signals down the adapter chain; each adapter is responsible for tearing its subprocess down cleanly.

---

## The Live Canvas

The canvas is the reason you'll want to use Loom.

**Token streams on edges.** Edges carrying the `stream` type render a custom path with points flowing in the direction of data. Speed is proportional to real-time tokens per second — fast streams look like light; slow ones look like a trickle.

**Live meters.** Every executing node shows a progress ring, a running token/cost/latency badge, and, for agent nodes, a thinking bubble with the last few tokens generated.

**Run replay.** When a run finishes, a timeline scrubber appears at the bottom of the canvas. Drag it to rewind the canvas to any point in time. Click a node to see exactly what it received and produced at that moment.

**Type-aware editing.** Dragging from a port highlights compatible targets and dims incompatible ones. When types are close but not equal, Loom suggests inserting a converter node.

**Breakpoints and mocks.** Drop a breakpoint on any node to pause execution there and inspect its inputs. Toggle mock mode on an agent node to replace its output with a fixture — perfect for fast graph iteration without burning tokens.

**Quick spawn.** Double-click the canvas to open a fuzzy node picker. Type a few characters, hit Enter, drop.

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

**Frontend.** React 18, TypeScript, Vite, [React Flow](https://reactflow.dev), Tailwind, shadcn/ui, Zustand, Monaco (for in-node code editing).

**Backend.** Node.js 20+, TypeScript, Fastify (HTTP), `ws` (WebSocket streaming), `better-sqlite3` (traces and checkpoints), `zod` (schema validation), `yaml` (flow parser).

**Adapters.** `@anthropic-ai/sdk`, Claude Code CLI wrapper, Codex CLI wrapper, a LiteLLM proxy bridge (spawns a Python `litellm` subprocess on first use).

**Protocol.** [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) for MCP.

Loom does not use Electron. It runs as a local HTTP server and opens your default browser — faster startup, smaller install, easier updates.

---

## Project Structure

```
loom/
├── apps/
│   ├── studio/              Frontend (Vite + React + React Flow)
│   │   └── src/{canvas, nodes, edges, palette, inspector, runs}
│   └── server/              Backend (Fastify + TypeScript)
│       └── src/{api, runner, storage, mcp}
├── packages/
│   ├── core/                Shared types and zod schemas
│   ├── adapters/            {claude-api, claude-code, codex, litellm}
│   └── nodes/               Node definitions — runtime behavior + UI metadata
├── examples/                Ready-to-run flow.yaml files
└── docs/                    Architecture, adapter authoring, node authoring
```

Monorepo managed by pnpm workspaces.

---

## Design Decisions

These are the non-obvious calls Loom makes. Knowing them up front will save you time.

- **Node.js, not Python.** The runtime is Node because Claude Code is Node and wrapping it as a subprocess is trivial. LiteLLM runs as a child Python process, started on demand.
- **Plain terms, not a bespoke vocabulary.** dot-studio uses `Tal / Dance / Performer / Act`. Loom uses `Flow / Node / Port / Edge / Run`. The cost of inventing vocabulary isn't worth the metaphor.
- **Condition graphs, not choreography.** Loom is a workflow engine with explicit branching, not a runtime collaboration layer. Agents talk to each other by exchanging values on edges, not by chatting freely.
- **flow.yaml is the source of truth.** The canvas is a view on the file. Editing `flow.yaml` by hand is a fully supported workflow — the canvas reflects the file, never overrides it.
- **Run-scoped sessions.** Session nodes (Claude Code, Codex) live for exactly one run. They do not persist across runs. Long-term memory lives in `memory.memento` or `memory.blackboard`, never in CLI process state.
- **Strong port types, with escape hatches.** Port mismatches are errors by default, but a converter node is always one click away.
- **Local-first, always.** Loom never phones home. No telemetry, no login, no cloud sync. v1.0 adds *optional* remote execution; it will never be mandatory.
- **No Electron.** A local HTTP server plus the user's browser beats a 200 MB Electron bundle for startup, memory, and update ergonomics.

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
