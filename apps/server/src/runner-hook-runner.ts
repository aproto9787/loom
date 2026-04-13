import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentConfig } from "@loom/core";
import type { RunResources } from "./runner-resource-loader.js";

const execAsync = promisify(exec);

export type HookEvent = "on_start" | "on_complete" | "on_error" | "on_delegate";

export async function runHooks(
  agent: AgentConfig,
  event: HookEvent,
  resources: RunResources,
  env: Record<string, string>,
): Promise<void> {
  if (!agent.hooks?.length) return;

  for (const hookName of agent.hooks) {
    const hook = resources.hooks.get(hookName);
    if (!hook || hook.event !== event) continue;
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
