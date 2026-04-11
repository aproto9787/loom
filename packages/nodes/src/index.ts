import type { FlowNode } from "@loom/core";

export interface NodeDefinition {
  type: FlowNode["type"];
  title: string;
  category: string;
}

export const nodeDefinitions: NodeDefinition[] = [
  { type: "io.input", title: "Input", category: "io" },
  { type: "io.output", title: "Output", category: "io" },
  { type: "agent.claude", title: "Claude", category: "agent" },
  { type: "agent.litellm", title: "LiteLLM", category: "agent" },
];
