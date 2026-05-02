import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig, HookEvent } from "@aproto9787/heddle-core";
import type { RunResources } from "./resource-loader.js";

const execAsync = promisify(exec);

export type { HookEvent } from "@aproto9787/heddle-core";

export async function runHooks(
  agent: AgentConfig,
  event: HookEvent,
  resources: RunResources,
  env: Record<string, string>,
): Promise<void> {
  if (!agent.hooks?.length) {
    return;
  }

  for (const hookName of agent.hooks) {
    const hook = resources.hooks.get(hookName);
    if (!hook || hook.event !== event) {
      continue;
    }

    try {
      await execAsync(hook.command, {
        env: { ...process.env, ...env },
        timeout: 30_000,
      });
    } catch (error) {
      console.error(`Hook execution failed for ${hook.name}`, error);
    }
  }
}
