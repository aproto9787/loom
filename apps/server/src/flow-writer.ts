import YAML from "yaml";
import type { FlowDefinition } from "@loom/core";

export function stringifyFlow(flow: FlowDefinition): string {
  return YAML.stringify(flow);
}
