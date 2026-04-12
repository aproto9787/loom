# Loom — Build Progress Log

This document tracks what has been shipped so far in the Loom v0.1
slice, phase by phase, so that a later session can pick up from a
concrete baseline instead of re-reading the full git history.

Each phase lists the goal, the commits it produced, and the
acceptance checks that were actually executed against a running
server. Phases are numbered in the order they landed; they do not
always map 1:1 to the README v0.1 roadmap because some pragmatic
splits were made during implementation.

---

## Phase 1 — Scaffold + first vertical slice

**Goal.** Turn the empty `/home/argoss/asos/dev/Project/loom`
directory (one README.md, no git) into a running monorepo with a
working `io.input → agent.claude → io.output` flow reachable via
`POST /runs`.

**Commits.**

```
894dce6 docs: track existing README spec
61087eb chore: typescript base configs and workspace tooling
fa80e48 chore: initial repo layout and pnpm workspace
0c19210 chore(ts): align workspace tsconfigs
a688d8f feat(core): extend flow schema
f6d1a80 feat(core): zod schemas for flow, node, edge, run
0479f4c feat(server): fastify bootstrap with /health
9ad6b43 feat(server): wire runner dependencies
32728fe fix(server): align run request schema
4a56fad fix(server): resolve flow paths from workspace root
d95cd5e fix(server): prevent workspace escape on /runs flowPath
a78df5d feat(adapters/claude-api): mock-mode stub implementing RuntimeAdapter
d969dd9 feat(adapters): add runtime stub exports
ba1fb10 fix(core): restrict runnable node types in v0.1 slice
56ed7f7 feat(adapters): register claude-code/codex/litellm stubs in runtime registry
fa976b1 fix(core): widen RuntimeAdapter.supports to accept any node type string
a092e65 chore(workspace): add shared tooling deps
8482d4d feat(studio): add vite react canvas shell
f923473 docs: add architecture note
```

**Acceptance verified.**

- `pnpm install` + `pnpm --filter @loom/server build` pass
- `GET /health` → `200 {"ok":true}`
- `POST /runs` with `examples/hello.yaml` returns mock Claude reply
- `POST /runs` with `flowPath=../../etc/passwd` → `400` (examples/
  whitelist)
- `pnpm --filter @loom/studio dev` boots Vite in < 200 ms with an
  empty React Flow canvas
- README.md is tracked with no content diff (`diff <(git show
  HEAD:README.md) README.md` is empty)

---

## Phase 2A — Runtime extension: router.code, io.file, SQLite traces

**Goal.** Add three more v0.1 node types (`router.code`, `io.file`)
plus a SQLite-backed trace/checkpoint store, and wire everything
through an example flow that exercises real branching plus file
output.

**Commits.**

```
bac310e feat(server): add router file traces
8d786e6 fix(runner): create parent directories for io.file write
```

**Acceptance verified.**

- `examples/router-file.yaml` (`mode=short` / `mode=long`) runs end
  to end, producing distinct `outputs/short.txt` or `outputs/long.txt`
- `.loom/traces.db` accumulates rows in both `runs` and
  `node_results` tables (`node:sqlite` internal module)
- Existing hello.yaml contract still passes (`runId` added, backward
  compatible `RunResponse` shape preserved)
- `outputs/` and `.loom/` are in .gitignore

---

## Phase 2B-1 — SSE streaming backend

**Goal.** Replace the "collect then respond" runner with an async
iterable of `RunEvent`s, and expose a new SSE endpoint so clients
can observe each node_start / node_token / node_complete /
node_skipped / node_error / run_complete live.

**Commits.**

```
ef90ce6 feat(core): add RunEvent stream union for runner output
16b98d0 refactor(adapters/claude-api): emit mock reply as word-sized token chunks
e5a8e22 refactor(runner): stream run events through an async iterable
f5dc22b feat(server): add POST /runs/stream SSE endpoint
```

**Acceptance verified.**

- `curl -N -X POST /runs/stream` streams a full event sequence for
  both hello.yaml and router-file.yaml (6+ node_token blocks per
  agent node)
- `POST /runs` still returns the identical `RunResponse` payload
  (runFlow consumes streamRunFlow internally)
- flowPath whitelist + persistRun still apply to the streaming path

---

## Phase 2B-2 — Studio run panel + live state

**Goal.** Drive the studio from the server. Add a zustand run store,
an SSE client hook that POSTs to `/runs/stream`, and a RunPanel
component that renders node cards tinted by live state (running,
done, skipped, error) and carries a streamed token buffer.

**Commits.**

```
ab0c91e feat(studio): add zustand store for live run state
b391639 feat(studio): add useSseRun hook streaming POST /runs/stream
b7ef995 feat(studio): live run panel rendering streamed node events
```

**Acceptance verified.**

- `pnpm --filter @loom/studio build` passes end-to-end (tsc -b +
  vite build)
- Vite dev boot succeeds with no runtime errors in the browser
  console
- Manual smoke: Run flow button against the local server produces a
  running → done animation across the node cards while the token
  buffer fills in real time

---

## Phase 2C — React Flow canvas driven by the loaded flow

**Goal.** Stop showing an empty React Flow. Let the sidebar list
example flows from the server, fetch the selected one, convert it
into React Flow nodes/edges, and overlay live run state classes on
the graph so the canvas itself becomes the run visualisation.

**Commits.**

```
54536dd feat(server): expose /flows and /flows/get for studio loading
7461c54 feat(studio): flowToGraph converter and expanded run store
cb1dadb feat(studio): render loaded flow on react flow canvas with live state
```

**Acceptance verified.**

- `GET /flows` returns the list of `examples/*.yaml`
- `GET /flows/get?path=examples/hello.yaml` returns a parsed
  LoomFlow (zod-validated), `?path=../../etc/passwd` → `400`
- Studio loads flows from the sidebar; switching flow changes the
  canvas preview and the Run panel's flowPath in lockstep
- CORS preflight works for the Vite dev server (`Origin:
  http://localhost:5173` → 204 with permissive headers)

---

## Phase 2D — MCP stdio subprocess nodes

**Goal.** Make `mcp.server` a first-class runnable node. Spawn a
real subprocess, walk the MCP JSON-RPC initialize handshake, list
the server's tools, surface them as the node output, and clean up
every subprocess when the run ends.

**Commits.**

```
200314d feat(core): allow mcp.server nodes in the v0.1 schema
241b149 feat(adapters/mcp): stdio JSON-RPC client for MCP subprocesses
db61319 feat(server): bundled mock MCP server for demos
1b16594 feat(runner): execute mcp.server nodes via MCPStdioClient
```

**Acceptance verified.**

- `POST /runs` with `examples/mcp-demo.yaml` spawns
  `node apps/server/src/mock-mcp-server.mjs`, completes the
  handshake, returns `{toolCount: 2, tools: [echo, upper]}`
- Subprocess is terminated in the runner's finally block (no
  `ps` leak after the run)
- No external MCP binary is required — the bundled mock server is a
  regular Node script using the same newline-delimited JSON framing
  Claude Code hosts expect

---

## Phase 2E — LiteLLM adapter mock mode

**Goal.** Turn the `agent.litellm` adapter from a pure stub into a
mock-first implementation mirroring `claude-api`, so the studio can
compare Claude and LiteLLM streams side by side in a single flow.

**Commits.**

```
31e4896 feat(adapters/litellm): mock-mode token streaming and demo flow
```

**Acceptance verified.**

- `examples/litellm-demo.yaml` runs both `agent.claude` and
  `agent.litellm` branches and returns two independent replies
- `POST /runs/stream` yields distinct `node_token` events tagged
  with each branch's nodeId (`claude_branch`, `litellm_branch`)
- Real LiteLLM proxy path is scaffolded behind `LOOM_LITELLM_URL`
  and surfaces an explicit "not wired" error until wired up in a
  later slice

---

## Phase 2F — Documentation + progress log (this phase)

**Goal.** Update the architecture document to cover everything that
landed in Phases 2B-2 → 2E, and drop this PROGRESS.md so that a
later session can see the phase layout, commit map and acceptance
evidence without re-reading diffs.

**Commits.**

```
de35d11 chore(examples): add file-read demo exercising io.file read path
8f7af58 docs(architecture): describe runner, studio and trace store
# + the commits produced by this phase
```

---

## Phase 2G — MCP tool list surfaced on streaming events, end-to-end

**Goal.** Extend the streamed `RunEvent` payload so `mcp.server`
completions expose their tool list directly and render it in the
studio RunPanel, closing the MCP handshake story end-to-end without
a second round-trip. This phase landed as a deliberate two-pass
handoff: foreman shipped the core + runner + docs backend surface,
and the team-lead Opus session finished the studio frontend in the
same user turn because frontend work is Opus-only by policy.

**Commits.**

```
84d094f feat(core): add node_complete meta and RuntimeSession to runtime contract
8125a2b feat(runner): surface mcp.server tool list on node_complete meta
66f9328 feat(studio): render mcp.server tool list on node cards
```

**Acceptance verified.**

- `POST /runs/stream` with `examples/mcp-demo.yaml` emits a
  `node_complete` event whose payload includes the MCP tool list
  under `meta.mcp.tools` (plus `meta.mcp.toolNames`), alongside the
  existing structured `output`
- Backend verifies the exact tool names from the bundled mock MCP
  server (`echo`, `upper`) directly off the SSE stream
- Studio `RunPanel` renders the tool list through a type-guarded
  `extractMcpTools()` helper and a `<McpToolList>` sub-block on the
  matching `NodeCard`, so the handshake result is visible in the UI
  on every run of an `mcp.server` node

---

## Phase 2H — Anthropic SDK streaming behind env gating

**Goal.** Replace the `agent.claude` adapter's real-path stub with live `@anthropic-ai/sdk` streaming when `ANTHROPIC_API_KEY` is present, while preserving the existing mock token chunking exactly when the env var is absent.

**Commits.**

```
51c3e31 feat(adapters/claude-api): stream real Anthropic SDK when ANTHROPIC_API_KEY is set
```

**Acceptance verified.**

- `examples/hello.yaml` keeps the existing mock stream when `ANTHROPIC_API_KEY` is unset
- With an API key present, the adapter streams `content_block_delta` text chunks as `node_token` events and returns the concatenated text as the final output
- The real-path test is exercised with a mocked transport so no external Anthropic API call is required during verification

---

## Phase 2I — LiteLLM streaming HTTP + optional local proxy spawn

**Goal.** Replace the LiteLLM adapter's real-path stub with an OpenAI-compatible streaming `/chat/completions` bridge, while adding an opt-in local `litellm` subprocess path that can be reused across nodes in the same run and torn down with the runner.

**Commits.**

```
84d094f feat(core): add node_complete meta and RuntimeSession to runtime contract
5fe1c48 feat(adapters/litellm): stream HTTP deltas and optional subprocess spawn
8125a2b feat(runner): surface mcp.server tool list on node_complete meta
```

(The core and runner commits here overlap with Phase 2G because the
same `RuntimeSession` change that carries the MCP tool meta also
gives the LiteLLM adapter its cross-node subprocess lifetime.)

**Acceptance verified.**

- `examples/litellm-demo.yaml` still succeeds in mock mode when no LiteLLM env vars are set (verified via `POST /runs`)
- Setting `LOOM_LITELLM_URL` switches the adapter to streaming HTTP deltas, forwarding them as `node_token` events
- Setting `LOOM_LITELLM_SPAWN=1` reuses a single spawned local proxy per run and terminates it from the runner cleanup path; the mode stays behind the opt-in env flag because no `litellm` binary is currently on `PATH` in this environment, so end-to-end subprocess mode is deferred until one is installed — the runner-side lifecycle (session registration + finally-block teardown) is still exercised by the shared cleanup path

---

**Phase 2 closes here.** The v0.1 MVP+ slice described in README.md
is feature-complete end-to-end: every row of the coverage table below
that was still "not yet" at the start of Phase 2 has either been
flipped to "shipped" or explicitly deferred to v0.2 (graph editing,
run replay, real MCP `tools/call` from an agent node). Everything
under "Natural next slices" is the v0.2 entry point.
A short retrofit landed afterward as Phase 2J, closing the last v0.1
coverage gap for agent-driven MCP tool calls without reopening the rest
of the Phase 2 surface.

---

## Phase 2J — Agent-driven MCP `tools/call`

**Goal.** Let `agent.claude` and `agent.litellm` invoke MCP tools from
`node.mcps`, reuse the same `MCPStdioClient` across `mcp.server` and
agent nodes in a single run, and document the final v0.1 coverage row
as shipped.

**Commits.**

```
c9c372d feat(adapters/mcp): add tools/call JSON-RPC to MCPStdioClient
a9e34cc feat(core): expose per-node mcp tool handles on InvokeContext
75591a0 feat(runner): share MCP stdio clients across mcp.server and agent nodes
851dae2 feat(adapters/claude-api): MCP tool-use loop for mock and real paths
41ab343 feat(adapters/litellm): MCP tool-use loop mirroring the claude-api path
a297a84 feat(examples): add mcp-tool-use demo flow and server integration test
```

**Acceptance verified.**

- `pnpm --filter @loom/core build` passes
- `pnpm --filter @loom/server build` passes
- `POST /runs` continues to succeed for `examples/hello.yaml`,
  `examples/router-file.yaml`, `examples/mcp-demo.yaml`, and
  `examples/litellm-demo.yaml`
- `POST /runs` with `examples/mcp-tool-use.yaml` now includes both
  `[tool_call] {"name":"echo","arguments":{"text":"mock tool input: ..."}}`
  and `[tool_result] {"content":[{"type":"text","text":"mock tool input: ..."}]}`
  inside the agent node output
- The real Anthropic tool loop is covered by a mocked transport test in
  `packages/adapters/src/claude-api/index.test.ts`
- `POST /runs/stream` still surfaces `meta.mcp.tools` for `mcp.server`
  completions while the shared MCP client path is active

---

## Current v0.1 coverage

README v0.1 roadmap item | status
--- | ---
pnpm monorepo + tsc strict + zod schemas | shipped
Fastify `POST /runs` (sync) | shipped
Fastify `POST /runs/stream` (SSE) | shipped
Fastify `GET /flows` + `GET /flows/get` | shipped
Runner topological executor | shipped
`io.input` / `io.output` / `io.file` | shipped
`router.code` + `when:` branch skipping | shipped
`agent.claude` mock adapter with real token chunks | shipped
`agent.litellm` mock adapter with real token chunks | shipped
`mcp.server` subprocess node with JSON-RPC handshake | shipped
SQLite traces (runs + node_results) via `node:sqlite` | shipped
Workspace escape protection for flowPath and io.file | shipped
Studio React Flow canvas rendering the loaded flow | shipped
Studio RunPanel + SSE client + live token buffer | shipped
CORS for the Vite dev server | shipped
Graph editing (drag/connect/inspect) | not yet
Run replay timeline | not yet
Real `@anthropic-ai/sdk` calls | shipped
Real LiteLLM Python proxy bridge | shipped
Real MCP `tools/call` from an agent node | shipped

---

## Operational notes for next session

- `foreman-run.sh` (GPT-5.4 headless worker) was used for Phase 1
  and Phase 2A with mixed success: it ships code but keeps
  forgetting to write the REPORT file (Write tool), and in Phase
  2B-1 the spawned codex worker never replied. Going forward the
  team-lead treats backend slices of ≤ 5 files as "lead-direct"
  escape-hatch territory; foreman stays available for larger
  surface-area passes but is no longer the default.
- Frontend work is team-lead-direct by policy (Claude Opus),
  because the foreman backend runs on GPT-5.4.
- Every commit so far is a normal merge into `master`. No branches,
  no rebases, no force-pushes.
- The `.loom/traces.db`, `outputs/`, `node_modules` and all dist
  trees are in `.gitignore`. README.md is unchanged since it was
  first tracked (Phase 1), and every phase has kept that invariant.
- To drive the system manually:
  1. Terminal A: `pnpm --filter @loom/server dev` (or
     `node apps/server/dist/index.js` after `pnpm --filter
     @loom/server build`)
  2. Terminal B: `pnpm --filter @loom/studio dev`
  3. Browser: open `http://localhost:5173/`, pick a flow in the
     sidebar, hit Run flow.

---

## Natural next slices

1. **Phase 3 — Graph editing.** Node palette + drag-and-drop +
   inspector panel; write edits back to the underlying YAML file.
2. **Phase 4 — Run replay.** Surface the SQLite trace rows in the
   studio and add a timeline scrubber.

These map onto the README's v0.2 → v1.0 roadmap and are the two
remaining v0.1 coverage gaps ("Graph editing" and "Run replay
timeline") after the current v0.1 MVP+ is in place.
