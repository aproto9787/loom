import type { FlowNode } from "@loom/core";
export * from "./execute.js";
export * from "./validate.js";

export interface NodeDefinition {
  type: FlowNode["type"];
  title: string;
  category: string;
}

export const nodeDefinitions: NodeDefinition[] = [
  { type: "io.input", title: "Input", category: "io" },
  { type: "io.output", title: "Output", category: "io" },
  { type: "io.file", title: "File", category: "io" },
  { type: "router.code", title: "Code Router", category: "router" },
  { type: "router.llm", title: "LLM Router", category: "router" },
  { type: "agent.claude", title: "Claude", category: "agent" },
  { type: "agent.litellm", title: "LiteLLM", category: "agent" },
  { type: "agent.claude-code", title: "Claude Code", category: "agent" },
  { type: "agent.codex", title: "Codex", category: "agent" },
  { type: "memory.memento", title: "Memento", category: "memory" },
];
