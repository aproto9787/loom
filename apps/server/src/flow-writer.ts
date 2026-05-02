import YAML from "yaml";
import type { FlowDefinition } from "@aproto9787/heddle-core";

export function stringifyFlow(flow: FlowDefinition): string {
  return YAML.stringify(flow);
}
