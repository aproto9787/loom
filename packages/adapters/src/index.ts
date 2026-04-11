export * from "./claude-api/index.js";
export * from "./claude-code/index.js";
export * from "./codex/index.js";
export * from "./litellm/index.js";

import type { RuntimeAdapter } from "@loom/core";
import { claudeApiAdapter } from "./claude-api/index.js";
import { claudeCodeAdapter } from "./claude-code/index.js";
import { codexAdapter } from "./codex/index.js";
import { litellmAdapter } from "./litellm/index.js";

export const runtimeAdapters: RuntimeAdapter[] = [
  claudeApiAdapter,
  litellmAdapter,
  claudeCodeAdapter,
  codexAdapter,
];
