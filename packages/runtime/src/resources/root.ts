import path from "node:path";
import { defaultWorkspaceRoot } from "../paths.js";
import type { ResourceLoadOptions } from "./types.js";

export function getResourceRoot(options: ResourceLoadOptions = {}): string {
  return path.resolve(options.resourceRoot ?? defaultWorkspaceRoot());
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}
