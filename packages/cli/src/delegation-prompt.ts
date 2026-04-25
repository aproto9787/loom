import type { AgentConfig } from "@loom/core";

// Build a system-prompt snippet that instructs an agent to use Bash
// `loom-subagent ...` for sub-agent work instead of Claude Code's Agent tool.
// The snippet enumerates the direct children of `selfAgent` with a
// copy-paste-ready command template for each.
//
// When `selfAgent.agents` is empty or missing, returns an empty string.
export function buildDelegationPrompt(selfAgent: AgentConfig, selfName: string): string {
  const children = selfAgent.agents ?? [];
  if (children.length === 0) return "";

  const lines: string[] = [];
  const invoker = `node "\$LOOM_SUBAGENT_BIN"`;
  lines.push("");
  lines.push("## Subagent Delegation Protocol (Loom)");
  lines.push("");
  lines.push(`You have subagents. **Delegate by running Bash ${invoker} ... — do NOT use the Agent tool.** The subagent's final REPORT arrives as the Bash tool_result.`);
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
  lines.push("1. Replace the TODO briefing with a concrete, non-empty task before running the command.");
  lines.push("2. Prefer `--briefing` for one-line tasks. For long or multiline tasks, pipe stdin or use `--briefing-file <path>`.");
  lines.push("3. If a positional briefing starts with `--`, place it after a literal `--` so it is not parsed as an option.");
  lines.push("4. Never invoke the Agent tool for these roles — the Loom runtime tracks only Bash-spawned subagents.");
  lines.push("5. Explicit user delegation requests override the low-complexity direct-execution default.");
  lines.push("6. Without an explicit delegation request, direct execution is fine for low-complexity work; spawn subagents for independent slices, specialist work, broad parallel investigation, or review/fix gates.");
  lines.push("7. You may call multiple subagents in parallel only when their tasks are independent.");
  lines.push("8. Read the REPORT from stdout; decide next step based on `status:` and `summary:` lines.");
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

// Walk the flow's agent tree to find a node by name. Returns undefined if
// the name does not match any node.
export function findAgentByName(root: AgentConfig, name: string): AgentConfig | undefined {
  if (root.name === name) return root;
  for (const child of root.agents ?? []) {
    const found = findAgentByName(child, name);
    if (found) return found;
  }
  return undefined;
}
