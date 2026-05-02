# @aproto9787/heddle

Local agent control plane for Claude Code, Codex, MCP tools, and repository workflows.

## Install

```bash
npm i -g @aproto9787/heddle
heddle
```

Heddle launches a local host leader session, injects run-scoped MCP delegation
tools, and runs Heddle-managed child agents locally.

## What It Does

- Uses your local Claude Code or Codex profile as the host leader.
- Adds run-scoped Heddle MCP delegation tools to that leader.
- Exposes child agents as typed tools such as `heddle_delegate_reviewer`.
- Runs delegated workers locally with isolated HOME/config directories.
- Writes reports and trace events back to the local Heddle run history.

## Common Commands

```bash
heddle
heddle --flow examples/leader-workers.yaml
heddle --flow examples/leader-workers.yaml --prompt "Review this repo" --headless
heddle mcp
```

## Requirements

- Node.js `>=22.13.0`
- Claude Code and/or Codex installed locally for real provider-backed runs

Project site: https://aproto9787.github.io/heddle/

Repository: https://github.com/aproto9787/heddle
