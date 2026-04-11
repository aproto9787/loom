import type { FlowNode } from "@loom/core";

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
  { type: "agent.claude", title: "Claude", category: "agent" },
  { type: "agent.litellm", title: "LiteLLM", category: "agent" },
];
