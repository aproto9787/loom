import type { AgentConfig } from "@aproto9787/loom-core";
import { directChildren } from "@aproto9787/loom-runtime";

// Build a system-prompt snippet that instructs an agent to delegate through
// Loom MCP tools only. `loom-subagent` remains the internal runtime behind the
// MCP server, but leaders should never spawn it directly.
export function buildDelegationPrompt(selfAgent: AgentConfig, _selfName: string): string {
  const children = directChildren(selfAgent);
  if (children.length === 0) return "";

  const lines: string[] = [];
  lines.push("");
  lines.push("## Subagent Delegation Protocol (Loom)");
  lines.push("");
  lines.push("You must use Loom MCP delegation tools for child-agent work. Use `loom_delegate`, `loom_delegate_<agent>`, or `loom_delegate_many`.");
  lines.push("In Codex host sessions, Loom MCP tools may be lazily discoverable. Before deciding they are unavailable, call `tool_search` with a query like `loom delegate MCP tools` and then use the discovered `mcp__loom__` tools.");
  lines.push("Generic `loom_delegate` returns the child agent's final REPORT by default, but may return `status: running` if the MCP sync wait cap is reached before the child finishes. Agent-specific `loom_delegate_<agent>` tools always start asynchronously, even if `wait: true` is supplied; poll `loom_get_status` / `loom_read_report` until the REPORT is available.");
  lines.push("`loom_delegate_many` starts parallel tasks and may return `status: running` with taskIds; poll `loom_get_status` / `loom_read_report` until each child REPORT is available.");
  lines.push("If Loom MCP tools are unavailable or a Loom MCP call fails, stop and report `status: blocked` with the exact tool/discovery error. Do not spawn child agents with Bash.");
  lines.push("If the user explicitly asks to delegate, assign work, use workers/agents/team members, or parallelize, treat delegation as required for the relevant non-trivial work. Do not complete the whole task yourself unless no suitable subagent exists.");
  lines.push("");
  lines.push("Available subagents:");
  for (const child of children) {
    const role = child.role ?? child.description ?? "";
    const roleSuffix = role ? ` — ${role}` : "";
    lines.push(`- **${child.name}** (${child.type}${child.model ? `, ${child.model}` : ""})${roleSuffix}`);
  }
  lines.push("");
  lines.push("Rules:");
  lines.push("1. Use Loom MCP tools only for delegation; in Codex, search for them with `tool_search` before declaring them unavailable.");
  lines.push("2. Never run `loom-subagent`, `LOOM_SUBAGENT_BIN`, or other child-agent Bash commands directly.");
  lines.push("3. Never invoke the Agent tool for these roles — Loom tracks MCP-delegated subagents.");
  lines.push("4. Explicit user delegation requests override the low-complexity direct-execution default.");
  lines.push("5. Without an explicit delegation request, direct execution is fine for low-complexity work; delegate through MCP for independent slices, specialist work, broad parallel investigation, or review/fix gates.");
  lines.push("6. You may call multiple subagents in parallel only when their tasks are independent.");
  lines.push("7. Do not treat `status: running` as completion. For any `wait: false` delegation, poll until each REPORT is available; decide next step based on `status:`, `summary:`, `artifacts:`, and `blockers:` lines.");
  lines.push("");
  return lines.join("\n");
}
