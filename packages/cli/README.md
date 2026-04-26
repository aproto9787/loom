# @aproto9787/loom

Local agent control plane for Claude Code, Codex, MCP tools, and repository workflows.

## Install

```bash
npm i -g @aproto9787/loom
loom
```

Loom launches a local host leader session, injects run-scoped MCP delegation
tools, and runs Loom-managed child agents locally.

## What It Does

- Uses your local Claude Code or Codex profile as the host leader.
- Adds run-scoped Loom MCP delegation tools to that leader.
- Exposes child agents as typed tools such as `loom_delegate_reviewer`.
- Runs delegated workers locally with isolated HOME/config directories.
- Writes reports and trace events back to the local Loom run history.

## Common Commands

```bash
loom
loom --flow examples/leader-workers.yaml
loom --flow examples/leader-workers.yaml --prompt "Review this repo" --headless
loom mcp
```

## Requirements

- Node.js `>=22.13.0`
- Claude Code and/or Codex installed locally for real provider-backed runs

Project site: https://aproto9787.github.io/loom/

Repository: https://github.com/aproto9787/loom
