import type { AgentConfig } from "@loom/core";
import { directChildren, resolveAgentRuntime } from "@loom/runtime";

// Build a system-prompt snippet that instructs an agent to delegate through
// Loom. MCP tools are the preferred transport; Bash `loom-subagent` commands
// remain as an explicit fallback while MCP support rolls out.
export function buildDelegationPrompt(selfAgent: AgentConfig, selfName: string): string {
  const children = directChildren(selfAgent);
  if (children.length === 0) return "";
  const runtime = resolveAgentRuntime(selfAgent, true);
  const preferMcp = runtime.delegationTransport === "mcp";

  const lines: string[] = [];
  const invoker = `node "\$LOOM_SUBAGENT_BIN"`;
  lines.push("");
  lines.push("## Subagent Delegation Protocol (Loom)");
  lines.push("");
  if (preferMcp) {
    lines.push("You have Loom MCP delegation tools for child-agent work. Use `loom_delegate` or `loom_delegate_many` when those tools are available.");
    lines.push("In Codex host sessions, Loom MCP tools may be lazily discoverable. Before deciding they are unavailable, call `tool_search` with a query like `loom delegate MCP tools` and then use the discovered `mcp__loom__` tools.");
    lines.push("The MCP tool returns the child agent's final REPORT. Read `status:`, `summary:`, `artifacts:`, and `blockers:` before deciding the next step.");
    lines.push("Only fall back to the Bash commands listed below after the MCP tools are still unavailable or the MCP call fails.");
  } else {
    lines.push(`You have subagents. **Delegate by running Bash ${invoker} ... — do NOT use the Agent tool.** The subagent's final REPORT arrives as the Bash tool_result.`);
  }
  lines.push("If the user explicitly asks to delegate, assign work, use workers/agents/team members, or parallelize, treat delegation as required for the relevant non-trivial work. Do not complete the whole task yourself unless no suitable subagent exists.");
  lines.push("");
  lines.push("Available subagents:");
  for (const child of children) {
    const role = child.role ?? child.description ?? "";
    const roleSuffix = role ? ` — ${role}` : "";
    const modelFlag = child.model ? ` --model ${shellQuote(child.model)}` : "";
    const exampleBriefing = shellQuote(`TODO: replace with a concrete task for ${child.name}`);
    lines.push(`- **${child.name}** (${child.type}${child.model ? `, ${child.model}` : ""})${roleSuffix}`);
    lines.push(
      `  \`${invoker} --name ${shellQuote(child.name)} --backend ${backendFor(child.type)}${modelFlag} --parent ${shellQuote(selfName)} --briefing ${exampleBriefing}\``,
    );
  }
  lines.push("");
  lines.push("Rules:");
  lines.push("1. Prefer Loom MCP tools for delegation when they are available; in Codex, search for them with `tool_search` before using Bash fallback.");
  lines.push("2. Replace the TODO briefing with a concrete, non-empty task before running any fallback command.");
  lines.push("3. Prefer `--briefing` for one-line fallback tasks. For long or multiline tasks, pipe stdin or use `--briefing-file <path>`.");
  lines.push("4. If a positional fallback briefing starts with `--`, place it after a literal `--` so it is not parsed as an option.");
  lines.push("5. Never invoke the Agent tool for these roles — Loom tracks MCP-delegated or Bash-spawned subagents.");
  lines.push("6. Explicit user delegation requests override the low-complexity direct-execution default.");
  lines.push("7. Without an explicit delegation request, direct execution is fine for low-complexity work; spawn subagents for independent slices, specialist work, broad parallel investigation, or review/fix gates.");
  lines.push("8. You may call multiple subagents in parallel only when their tasks are independent.");
  lines.push("9. Read the REPORT before responding; decide next step based on `status:` and `summary:` lines.");
  lines.push("");
  return lines.join("\n");
}

function backendFor(type: AgentConfig["type"]): "claude" | "codex" {
  return type === "codex" ? "codex" : "claude";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_.\-/:=]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
