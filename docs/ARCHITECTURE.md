# Architecture

Loom is a pnpm monorepo that runs as two local services — a Node.js
API server and a Vite-powered React Flow studio — backed by a small
set of shared packages. This document describes the shape of the
system as it stands at the end of the early v0.1 slices.

```
┌────────────────────────────────────────────────────────┐
│                   Browser (React 19)                   │
│   ┌──────────────────────────────────────────────────┐ │
│   │  apps/studio                                      │ │
│   │    ├─ Sidebar flow list (GET /flows)              │ │
│   │    ├─ React Flow canvas (flowToGraph + state map) │ │
│   │    ├─ RunPanel with SSE client (POST /runs/stream)│ │
│   │    └─ zustand store (node runtimes / tokens)      │ │
│   └──────────────────────────────────────────────────┘ │
│                ▲ fetch + SSE                            │
└────────────────┼────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│            apps/server (Fastify + TypeScript)          │
│                                                         │
│   GET  /health                                         │
│   GET  /flows                — list examples/*.yaml    │
│   GET  /flows/get            — parsed LoomFlow (zod)   │
│   POST /runs                 — synchronous RunResponse │
│   POST /runs/stream          — SSE of RunEvent         │
│                                                         │
│   runner.ts ── streamRunFlow(AsyncGenerator<RunEvent>) │
│     ├─ topological sort                                │
│     ├─ when: routerId.branch == 'X' skipping           │
│     ├─ router.code JS expression evaluator             │
│     ├─ io.file read / write (workspace-scoped)         │
│     └─ agent.claude / agent.litellm → runtime adapters │
│                                                         │
│   trace-store.ts — node:sqlite (.loom/traces.db)       │
│     ├─ runs(run_id, flow_name, flow_path, …)           │
│     └─ node_results(run_id, node_id, output)           │
└─────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                 packages/* (shared)                    │
│                                                        │
│   core        zod schemas for flow/node/edge/run,      │
│               RuntimeAdapter interface, RunEvent union │
│   adapters    claude-api (mock-first), claude-code,    │
│               codex, litellm (stubs registered)        │
│   nodes       node definitions surfaced to studio      │
└────────────────────────────────────────────────────────┘
```

## Execution model

1. `POST /runs` (or `POST /runs/stream`) receives a `flowPath` plus
   an `inputs` map. `flowPath` is validated against the examples/
   whitelist before anything is read from disk.
2. `loadFlow()` resolves the path from the workspace root, reads
   the YAML, and hands it to `flowSchema.parse` so the rest of the
   runner can rely on a fully typed `LoomFlow`.
3. `streamRunFlow()` walks the nodes in topological order. For
   each node it checks `when:` gating, resolves inputs through the
   edge references (`$inputs.x`, `node.field`, or `a || b` fallback
   chains), executes the node body, and yields `node_start`,
   `node_token*`, `node_complete`, `node_skipped` or `node_error`
   events. On success it also yields a terminal `run_complete`.
4. `runFlow()` is a thin consumer of `streamRunFlow()` that collects
   the final outputs map and rebuilds the original synchronous
   `RunResponse` shape so `POST /runs` stays backward compatible.
5. Every completed run is persisted to `.loom/traces.db` through
   `trace-store.ts`, including all node outputs. The SQLite file
   is gitignored.

## Runtime adapters

A runtime adapter is a small interface declared in `packages/core`:

```ts
interface RuntimeAdapter {
  id: string;
  supports(nodeType: string): boolean;
  invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent>;
}
```

- `claude-api` is the only fully wired adapter today. It ships with
  a mock branch that splits a canned reply into token chunks so the
  runner and studio can observe a real stream without an API key.
  The real SDK path is a scaffold that throws a descriptive error
  and will be replaced with `@anthropic-ai/sdk` calls in a later
  slice.
- `litellm` is now a mock-first adapter as well. It emits a canned
  reply embedding the configured model and topic, split into word
  chunks so the runner and studio see real token events. The real
  proxy path is scaffolded behind `LOOM_LITELLM_URL` and throws a
  "not wired" error until the Python subprocess bridge lands.
- `claude-code` and `codex` adapters are registered stubs that report
  the relevant node type via `supports()` and surface a "not
  implemented" error when invoked, so the registry is always complete
  and the v0.2 adapter work has a clean place to land.
- `mcp/client.ts` ships an `MCPStdioClient` that speaks the minimal
  JSON-RPC 2.0 subset (initialize + tools/list + tools/call) over
  newline-delimited JSON on a child_process. The runner uses it to
  execute `mcp.server` nodes: spawn the command from `config`, walk
  the handshake, list tools, expose `{serverInfo, tools, toolCount}`
  as the node output, and kill every subprocess in a finally block
  so they cannot leak.

## Studio canvas

The studio has two side-by-side columns inside the canvas shell:

- **Graph column** — a read-only React Flow instance whose nodes and
  edges come from `flowToGraph(loadedFlow)`. A simple column-based
  layout places each node one layer past its deepest dependency and
  stacks siblings vertically. Run events reduce into a runtime map
  in zustand, and the App layers runtime classes on top of the
  graph so running/done/skipped/error states get distinct visuals
  and outgoing edges animate while the target is running.
- **Run panel** — a thin form with the flow path, a JSON inputs
  editor, and a Run button that calls `useSseRun` against the
  server. As each event arrives the panel renders per-node cards
  (state, streamed token buffer, structured output, error) and the
  final outputs once the run completes.

Flow selection from the sidebar drives both the canvas and the run
panel through the same zustand `flowPath`, so picking a new example
flow just updates the graph preview and leaves the rest in sync.

## Security posture (current slice)

- `flowPath` is always rewritten through `path.resolve` and must
  stay inside the `examples/` directory of the workspace. Absolute
  paths and `../` escapes are rejected with a 400 before any file
  is opened, and both `POST /runs` and `POST /runs/stream` share
  the same validator.
- `io.file` independently rejects any resolved path that leaves the
  workspace root, so a flow cannot read or write outside the repo.
- CORS is permissive in development only, to let the studio (Vite
  dev server on :5173) reach the Fastify server on :8787 without a
  proxy configuration. The current scope is local-first anyway, so
  this is intentional.

## What is not here yet

- Real LLM calls. Every agent node runs through a mock adapter
  today (`claude-api` and `litellm` both fabricate responses).
- Python LiteLLM proxy subprocess. The real HTTP path is scaffolded
  behind `LOOM_LITELLM_URL` but not yet exercised end-to-end.
- MCP `tools/call`. `mcp.server` nodes spawn, initialize and list
  tools, but actually invoking a listed tool from an agent node
  is a v0.2 stretch.
- Graph editing. The canvas is read-only; dragging, connecting and
  inspecting nodes lands later with the node palette work.
- Run replay. Traces are persisted to SQLite but the studio does
  not yet visualise past runs or scrub through them.

Everything above is what the current code actually does. Items that
are on the README v0.1/v0.2 roadmap but not yet wired live in the
"What is not here yet" section and are the natural next targets.
