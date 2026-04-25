# Local Agent Control Plane

This document is Loom's target product and runtime contract.

It describes the direction the implementation should move toward. It is not a
claim that every item is implemented today. `docs/CURRENT_STATE.md` remains the
code-backed status checklist.

## Product Position

Loom is a local control plane for coding agents.

The product should not feel like a blank node workflow builder. It should feel
like a browser workspace for the user's existing local AI development tools:

- Claude Code
- Codex
- MCP servers
- local repositories
- local roles, skills, hooks, and flow files

The primary user experience is:

```text
Developer starts Loom locally
  -> Loom detects local providers, MCPs, repo, and .loom config
  -> Studio shows a connected local workspace
  -> User edits the agent bench and workflows in the browser
  -> Host leader runs through the user's local Claude Code or Codex environment
  -> Loom-managed workers run locally in isolated sessions
  -> Reports and trace events return to Studio
```

Short product language:

```text
Your local AI dev team, controlled from the browser.
```

More precise technical language:

```text
Loom discovers local Claude Code, Codex, MCP, and repository state, then exposes
a browser control plane for composing and running local coding-agent teams.
```

## Core Runtime Model

The key split is:

```text
Leader comes from the provider.
Workers are managed by Loom.
Loom connects them with a delegation protocol and trace layer.
```

Target runtime:

```text
Loom Studio / Server
  -> Host Leader Session
       user-local Claude Code or Codex
       plus Loom leader overlay
  -> Loom MCP delegation tools
  -> Loom Subagent Runtime
       isolated Claude Code or Codex child sessions
  -> events / reports / traces
  -> .loom/traces.db and Studio
```

### Host Leader Session

The root leader is not a new agent invented by Loom. It is a host-backed session
using the user's local Claude Code or Codex provider profile.

The leader keeps the normal host experience:

- existing auth state
- existing provider config
- existing local tool behavior
- existing terminal/provider expectations

Loom adds only a non-destructive overlay:

- flow instructions
- root role/system instructions
- direct child-agent list
- delegation rules
- report and trace rules
- MCP delegation tools when available

Leader resources are prompt-only by default. Loom must not rewrite the user's
real provider config to apply flow-specific hooks, skills, or MCPs.

### Loom-Managed Workers

Workers are child sessions created by Loom for specific delegated work.

Workers should use:

- isolated home/config directories
- scoped MCPs
- scoped hooks
- scoped skills
- explicit briefing text
- mandatory REPORT output
- event posting with run and agent metadata
- timeout and concurrency limits

This keeps worker behavior reproducible and traceable without polluting the
user's host Claude Code or Codex configuration.

## Provider Profiles

Provider discovery should become a first-class concept.

```ts
type ProviderKind = "claude-code" | "codex";

interface ProviderProfile {
  id: string;
  kind: ProviderKind;
  displayName: string;
  command: string;
  version?: string;
  authState: "ready" | "missing" | "unknown";
  configSources: string[];
}
```

Examples:

```text
claude-default -> Claude Code from the user's host environment
codex-default  -> Codex from the user's host environment
```

Studio should expose provider status directly:

```text
Detected local providers

Claude Code
Status: Ready
Profile: claude-default
Command: claude

Codex
Status: Ready
Profile: codex-default
Command: codex
```

## Agent Runtime Semantics

The recursive flow tree can remain the source model. The missing concept is
runtime mode.

Target defaults:

```text
orchestrator.runtime.mode = host
child.runtime.mode = isolated
orchestrator.runtime.delegationTransport = mcp
fallback delegationTransport = bash
```

Target schema direction:

```ts
interface AgentRuntimeConfig {
  mode?: "host" | "isolated";
  profile?: string;
  applyResources?: "prompt-only" | "scoped-home";
  delegationTransport?: "mcp" | "bash";
}

interface AgentConfig {
  name: string;
  type: "claude-code" | "codex";
  enabled?: boolean;
  runtime?: AgentRuntimeConfig;
  agents?: AgentConfig[];
}
```

Example:

```yaml
version: "1"
name: Implement and Review
repo: .

orchestrator:
  name: leader
  type: codex
  runtime:
    mode: host
    profile: codex-default
    applyResources: prompt-only
    delegationTransport: mcp
  system: |
    Plan the work, delegate concrete tasks, read child reports, and make final
    decisions.
  agents:
    - name: implementer
      type: codex
      enabled: true
      runtime:
        mode: isolated
        profile: codex-default
        applyResources: scoped-home
      system: |
        Implement the assigned patch and report changed files.

    - name: reviewer
      type: claude-code
      enabled: true
      runtime:
        mode: isolated
        profile: claude-default
        applyResources: scoped-home
      system: |
        Review the assigned patch for correctness, regressions, and missing
        tests.
```

## MCP Delegation Transport

The target default delegation transport is MCP.

Current Bash delegation is useful as a fallback, but it is too command-shaped
for the main product model. The leader should call Loom delegation tools, not
copy a shell command from the prompt.

Target:

```text
Host Leader
  -> Loom MCP tool call
  -> Loom runtime validates the request
  -> Loom starts isolated subagent
  -> Loom returns REPORT and trace metadata
```

The MCP server is a single Loom server, not one server per agent:

```text
Loom MCP Server
  - loom_delegate
  - loom_delegate_<agent>
  - loom_delegate_many
  - loom_get_status
  - loom_read_report
  - loom_cancel
```

Agent-specific dynamic tools are generated from enabled direct children:

```text
loom_delegate_implementer
loom_delegate_reviewer
loom_delegate_tester
```

The generic tool remains available because it is easier to validate, test, and
keep stable across UI edits.

### Direct-Child Rule

The MCP server should expose only the current agent's direct children.

Example tree:

```text
leader
  architect
    implementer
    reviewer
  tester
```

Tool visibility:

```text
leader sees:
  - delegate architect
  - delegate tester

architect sees:
  - delegate implementer
  - delegate reviewer
```

This preserves the workflow tree. A leader should not silently skip an
intermediate orchestrator by directly calling a grandchild worker.

### Tool Contracts

Minimum sync tool:

```json
{
  "agent": "reviewer",
  "briefing": "Review the current patch for correctness and risks.",
  "timeoutSeconds": 900,
  "wait": true
}
```

Response:

```json
{
  "taskId": "task_abc123",
  "agent": "reviewer",
  "status": "done",
  "report": {
    "status": "done",
    "summary": [
      "No blocking regressions found"
    ],
    "artifacts": [
      ".loom/runs/run_123/reviewer-report.md"
    ],
    "blockers": []
  }
}
```

Parallel tool:

```json
{
  "tasks": [
    {
      "agent": "implementer",
      "briefing": "Implement the requested API change."
    },
    {
      "agent": "tester",
      "briefing": "Design tests for the requested API change."
    }
  ]
}
```

MVP behavior:

- `loom_delegate` defaults to sync `wait: true`.
- `loom_delegate_<agent>` routes directly to that enabled direct child.
- `loom_delegate_many` handles parallel worker starts in one tool call.
- Async `wait: false`, `loom_get_status`, `loom_read_report`, and
  best-effort `loom_cancel` are available for longer tasks.

## Studio UX Mapping

Studio should expose the runtime model as an agent bench, not as raw node
plumbing.

```text
Agent Bench

[ON]  Implementer   Codex       -> exposed as a Loom delegation tool
[ON]  Reviewer      Claude Code -> exposed as a Loom delegation tool
[OFF] Tester        Codex       -> not exposed to the leader
```

Turning an agent on means the current leader can delegate to it. Turning an
agent off removes it from the delegation tool surface.

Studio should show:

- connected workspace
- detected providers
- detected MCPs/resources
- selected host leader
- active worker bench
- flow YAML diff
- run trace
- agent reports
- changed files and failed commands

## Security Invariants

MCP makes delegation more structured than Bash, but it does not make execution
safe by itself.

The Loom MCP handler must enforce:

- agent names are selected from direct-child enum values
- disabled agents cannot be called
- briefing text is never interpolated into shell commands
- report paths are generated by Loom
- run token/session identity is validated
- timeout is enforced
- concurrency limit is enforced
- workspace root is validated
- Studio can display which tool was called and by which leader

The leader should not receive arbitrary shell templates as the primary
delegation path when MCP is available.

## Implementation Plan

Recommended order:

1. Document target contract.
2. Add runtime schema fields with backwards-compatible defaults:
   `runtime.mode`, `runtime.profile`, `runtime.applyResources`,
   `runtime.delegationTransport`, and `enabled`.
3. Add provider discovery:
   Claude Code, Codex, command path, version, auth/config source.
4. Extract subagent execution from the CLI wrapper into shared runtime helpers.
5. Add `packages/mcp` and a `loom mcp` stdio command.
6. Implement `loom_delegate` with sync execution through the shared subagent
   runtime.
7. Implement `loom_delegate_many`.
8. Generate agent-specific `loom_delegate_<agent>` tools for enabled direct
   children.
9. Change leader delegation overlay to prefer MCP tools while keeping Bash
   fallback instructions.
10. Surface provider state, delegation transport, and enabled worker tools in
   Studio.

## Non-Goals

This direction does not require:

- a generic visual DAG runtime
- typed edges
- general graph node execution
- cloud execution of repository code
- rewriting the user's global Claude Code or Codex config by default

YAML remains the source of truth for shareable flow state, but the primary user
experience should be browser-based local agent control.
