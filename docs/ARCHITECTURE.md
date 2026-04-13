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
│   runner.ts ── loadFlow() + public runner exports      │
│     ├─ runner-executor.ts → streamRunFlow / runFlow    │
│     ├─ runner-prompt-builder.ts → agent prompt build   │
│     ├─ runner-resource-loader.ts → roles/hooks/skills  │
│     ├─ role merge + capability-aware delegation hints  │
│     └─ isolated HOME + scoped MCP config per agent     │
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
3. `streamRunFlow()` now resolves a recursive `orchestrator` tree,
   allocates one `AbortController` plus loaded role / hook / skill
   resources for the run, and emits `run_start`, `agent_start`,
   `agent_token`, `agent_delegate`, `agent_complete`, `agent_error`,
   `agent_timeout`, `agent_abort`, `run_complete`, `run_aborted`, or
   `run_error` events as the tree executes.
4. `executeAgent()` in `runner-executor.ts` is the runtime core. It
   builds the effective agent config, chooses the adapter, records
   per-agent timestamps/results, runs hooks, supports sibling-parallel
   delegation, and gives isolated agents a temporary HOME plus a
   scoped `.mcp.json` assembled only from the resources they can see.
5. `buildConfiguredAgent()` in `runner-prompt-builder.ts` merges role
   defaults into each agent, recursively applies the same merge to
   child agents, and injects capability/description metadata into the
   delegation prompt so parent agents can route work to the most
   appropriate child.
6. `runFlow()` is the synchronous wrapper around `executeAgent()` and
   rebuilds the final `RunResponse` from the collected agent results.
   Every completed, failed, or aborted run is persisted to
   `.loom/traces.db` through `trace-store.ts`.

## Agent isolation and scoped resources

`AgentConfig` now carries two orchestration-specific fields:

- `isolated` — when true, the runner creates a temporary HOME for the
  spawned CLI process and removes it during cleanup. This lets Claude
  Code or Codex agents run without inheriting the user's default home
  directory state.
- `capabilities` — free-form labels that are surfaced into parent
  prompts so delegation can target the most appropriate child agent.

Resource scoping is assembled from two places:

- Flow-level resources (`flow.resources.{mcps,hooks,skills}`) apply to
  every agent in the tree.
- Agent-level resource lists are merged on top via
  `resolveAgentResources()`.

When an agent has MCP bindings, `createScopedMcpConfig()` writes a
throwaway `.mcp.json` containing only the selected servers. Non-isolated
agents may inherit MCP server entries from the user's `~/.claude.json`;
isolated agents intentionally skip that global file and see only the
workspace-level `.mcp.json` entries that were explicitly selected.

## Capabilities and roles

Roles live as YAML files in `roles/` and are loaded on each run, plus
exposed through `GET /roles`, `GET /roles/:name`, `PUT /roles/save`, and
`DELETE /roles/:name`.

A role can define:

- `type`, `model`, `system`, `effort`, and `description`
- `capabilities`
- `isolated`
- role-scoped MCP defaults

When an agent sets `role: <name>`, `buildConfiguredAgent()` merges role
values first and then lets explicit agent fields win. In practice this
means a role can provide default capabilities and isolation, while an
individual agent can still override them when needed.

On the studio side, the Workflow tab agent editor and the dedicated
Roles tab both surface these defaults, so authors can see when a role is
supplying the effective type, effort, isolation, or capability set.

## Runtime adapters

A runtime adapter is a small interface declared in `packages/core`:

```ts
interface RuntimeAdapter {
  id: string;
  supports(nodeType: string): boolean;
  invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent>;
}
```

- `claude-api` remains mock-first when `ANTHROPIC_API_KEY` is
  absent, preserving the existing word-sized token chunks when no MCP
  servers are attached and switching to a deterministic first-tool
  simulation when `node.mcps` is present. When the key is present, the
  adapter switches to `@anthropic-ai/sdk` `messages.stream()`, declares
  every bound MCP tool as an Anthropic tool, executes each streamed
  `tool_use` through the runner-provided MCP handle, and resumes the
  conversation until the model finishes with plain text.
- `litellm` is also mock-first, preserving the existing canned reply
  and token chunking whenever neither `LOOM_LITELLM_URL` nor the opt-in
  `LOOM_LITELLM_SPAWN=1` path is active and no MCP servers are attached.
  With MCP bindings present it mirrors the Claude mock path by issuing a
  deterministic first-tool simulation. With `LOOM_LITELLM_URL` set it
  POSTs to the OpenAI-compatible `/chat/completions` endpoint,
  reconstructs streamed `tool_calls`, executes them against the same MCP
  handles, and continues streaming text deltas as `node_token` chunks.
  With `LOOM_LITELLM_SPAWN=1`, the adapter starts a local `litellm`
  proxy on first use, reuses it across nodes via the runner runtime
  session, and tears it down during runner cleanup.
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
  final outputs once the run completes. When a `node_complete` event
  carries `meta.mcp.tools`, the matching card also renders the MCP
  tool list (name + description) in a dedicated sub-block, so the
  mcp.server handshake surfaces directly in the UI without a second
  round-trip.

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
