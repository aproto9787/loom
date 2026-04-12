import YAML from "yaml";
import type { LoomFlow } from "@loom/core";

export function stringifyFlow(flow: LoomFlow): string {
  return YAML.stringify(flow);
}
