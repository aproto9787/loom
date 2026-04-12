import { readFile, readdir, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import {
  flowDefinitionSchema,
  hookDefinitionSchema,
  skillDefinitionSchema,
  type AgentConfig,
  type FlowDefinition,
  type HookDefinition,
  type RunAgentResult,
  type RunEvent,
  type RunResponse,
  type SkillDefinition,
} from "@loom/core";
import { getAgentAdapter, parseParallelDelegationDirective } from "@loom/adapters";
import { validateFlow } from "@loom/nodes";
import { persistRun } from "./trace-store.js";

const execAsync = promisify(exec);
const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const hooksDir = path.join(workspaceRoot, "hooks");
const skillsDir = path.join(workspaceRoot, "skills");

interface LoadedFlow {
  absolutePath: string;
  flowDir: string;
  flow: FlowDefinition;
}

interface RunResources {
  hooks: Map<string, HookDefinition>;
  skills: Map<string, SkillDefinition>;
}

interface ExecutionState {
  runId: string;
  agentResults: RunAgentResult[];
  agentNameCounts: Map<string, number>;
  resources: RunResources;
  abortController: AbortController;
}

interface AgentExecutionResult {
  output: string;
  error?: string;
}

// ── Resource loading ─────────────────────────────────────────────

async function loadHookDefinitions(): Promise<Map<string, HookDefinition>> {
  const map = new Map<string, HookDefinition>();
  try {
    await mkdir(hooksDir, { recursive: true });
    const entries = await readdir(hooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const raw = await readFile(path.join(hooksDir, entry.name), "utf8");
      const parsed = hookDefinitionSchema.safeParse(YAML.parse(raw));
      if (parsed.success) map.set(parsed.data.name, parsed.data);
    }
  } catch { /* skip */ }
  return map;
}

async function loadSkillDefinitions(): Promise<Map<string, SkillDefinition>> {
  const map = new Map<string, SkillDefinition>();
  try {
    await mkdir(skillsDir, { recursive: true });
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const raw = await readFile(path.join(skillsDir, entry.name), "utf8");
      const parsed = skillDefinitionSchema.safeParse(YAML.parse(raw));
      if (parsed.success) map.set(parsed.data.name, parsed.data);
    }
  } catch { /* skip */ }
  return map;
}

async function loadRunResources(): Promise<RunResources> {
  const [hooks, skills] = await Promise.all([
    loadHookDefinitions(),
    loadSkillDefinitions(),
  ]);
  return { hooks, skills };
}

// ── Hook execution ───────────────────────────────────────────────

type HookEvent = "on_start" | "on_complete" | "on_error" | "on_delegate";

async function runHooks(
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
    } catch {
      // Hook failures don't halt execution
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function resolveFlowPath(flowPath: string): string {
  return path.isAbsolute(flowPath) ? flowPath : path.resolve(workspaceRoot, flowPath);
}

function resolveFlowCwd(flow: FlowDefinition, flowDir: string): string {
  if (!flow.repo) return flowDir;
  return path.isAbsolute(flow.repo) ? flow.repo : path.resolve(flowDir, flow.repo);
}

function nextResultAgentName(agentName: string, state: ExecutionState): string {
  const nextCount = (state.agentNameCounts.get(agentName) ?? 0) + 1;
  state.agentNameCounts.set(agentName, nextCount);
  return nextCount === 1 ? agentName : `${agentName}#${nextCount}`;
}

function recordAgentResult(
  state: ExecutionState,
  agentName: string,
  output: string,
  startedAt?: string,
  finishedAt?: string,
): void {
  state.agentResults.push({ agentName, output, startedAt, finishedAt });
}

function buildParallelChildPrompt(parentPrompt: string, siblingNames: string[]): string {
  return [
    parentPrompt,
    "",
    `When the task can be split across siblings, delegate independently to any of: ${siblingNames.join(", ")}.`,
    "If you need true sibling concurrency, emit one JSON line with this shape:",
    '{"parallel": [{"childAgent": "name", "reason": "subtask"}]}',
    "Do not use this JSON form for a single child.",
  ].join("\n");
}

function buildAgentPrompt(
  agent: AgentConfig,
  flowRepo: string,
  resources: RunResources,
): string {
  const sections: string[] = [];

  if (agent.system?.trim()) {
    sections.push(agent.system.trim());
  }

  // Inject skill prompts
  if (agent.skills?.length) {
    for (const skillName of agent.skills) {
      const skill = resources.skills.get(skillName);
      if (skill) {
        sections.push(`[Skill: ${skill.name}]${skill.description ? ` — ${skill.description}` : ""}\n${skill.prompt}`);
      }
    }
  }

  sections.push(`Shared flow repo: ${flowRepo}`);

  // MCP awareness (informational — actual MCPs are set globally)
  if (agent.mcps?.length) {
    sections.push(`MCP servers available to you: ${agent.mcps.join(", ")}`);
  }

  if (agent.agents?.length) {
    const children = agent.agents.map((child) => {
      const fields = [`name: ${child.name}`, `type: ${child.type}`];
      return `- ${fields.join(", ")}`;
    });

    sections.push([
      "You can delegate tasks to these agents:",
      ...children,
      "If you need to delegate, respond with exactly one line in this format:",
      "DELEGATE <child-agent-name>: <subtask for the child>",
      "Do not add any extra text when delegating.",
      "If you can finish the task yourself, respond with the final answer normally.",
    ].join("\n"));
  } else {
    sections.push("No child agents are available. Finish the task yourself.");
  }

  return sections.join("\n\n");
}

// ── Flow loading ─────────────────────────────────────────────────

export async function loadFlow(flowPath: string): Promise<LoadedFlow> {
  const absolutePath = resolveFlowPath(flowPath);
  const raw = await readFile(absolutePath, "utf8");
  const flow = flowDefinitionSchema.parse(YAML.parse(raw));
  const validationErrors = validateFlow(flow);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }
  return { absolutePath, flowDir: path.dirname(absolutePath), flow };
}

// ── Agent execution ──────────────────────────────────────────────

const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const activeRuns = new Map<string, AbortController>();

export function abortRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) {
    return false;
  }
  controller.abort();
  return true;
}

async function* executeAgent(
  agent: AgentConfig,
  input: string,
  flowRepo: string,
  flowCwd: string,
  state: ExecutionState,
): AsyncGenerator<RunEvent, AgentExecutionResult, undefined> {
  const adapter = getAgentAdapter(agent.type);
  const configuredAgent: AgentConfig = {
    ...agent,
    system: agent.parallel && agent.agents?.length
      ? buildParallelChildPrompt(buildAgentPrompt(agent, flowRepo, state.resources), agent.agents.map((child) => child.name))
      : buildAgentPrompt(agent, flowRepo, state.resources),
  };
  const resultAgentName = nextResultAgentName(agent.name, state);
  const startedAt = new Date().toISOString();
  const hookEnv = { LOOM_AGENT: agent.name, LOOM_AGENT_TYPE: agent.type };
  const timeoutMs = agent.timeout ?? DEFAULT_AGENT_TIMEOUT_MS;
  const childAgents = agent.agents ?? [];
  let timedOut = false;
  let aborted = false;

  yield { type: "agent_start", agentName: agent.name, agentType: agent.type };
  await runHooks(agent, "on_start", state.resources, hookEnv);

  try {
    for await (const event of adapter.spawn(configuredAgent, input, flowCwd, {
      signal: state.abortController.signal,
      timeoutMs,
      onAbort: () => {
        aborted = true;
      },
      onTimeout: () => {
        timedOut = true;
      },
    })) {
      if (event.type === "token") {
        yield { type: "agent_token", agentName: agent.name, token: event.content };
        continue;
      }

      if (event.type === "delegate") {
        const child = agent.agents?.find((c) => c.name === event.childAgent);
        if (!child) {
          throw new Error(`Agent ${agent.name} attempted to delegate to unknown child ${event.childAgent}`);
        }

        const delegatedChildren = [child];
        const parallelSiblings = agent.parallel
          ? childAgents.filter((candidate) => candidate.name !== child.name)
          : [];
        const delegatedSet = new Set([child.name]);
        const parallelDelegations = event.reason.trim().length > 0
          ? parseParallelDelegationDirective(event.reason)
          : undefined;

        for (const sibling of parallelSiblings) {
          const siblingReason = parallelDelegations?.find((entry: { childAgent: string; reason: string }) => entry.childAgent === sibling.name)?.reason ?? event.reason;
          if (!siblingReason.trim() || delegatedSet.has(sibling.name)) {
            continue;
          }
          delegatedChildren.push(sibling);
          delegatedSet.add(sibling.name);
          yield { type: "agent_delegate", parentAgent: agent.name, childAgent: sibling.name };
        }

        await runHooks(agent, "on_delegate", state.resources, { ...hookEnv, LOOM_DELEGATE_TO: delegatedChildren.map((entry) => entry.name).join(",") });

        const childRuns = delegatedChildren.map(async (delegatedChild) => {
          const childReason = delegatedChild.name === child.name
            ? event.reason
            : parallelDelegations?.find((entry: { childAgent: string; reason: string }) => entry.childAgent === delegatedChild.name)?.reason ?? event.reason;
          const iterator = executeAgent(delegatedChild, childReason, flowRepo, flowCwd, state);
          const forwardedEvents: RunEvent[] = [];
          let step = await iterator.next();
          while (!step.done) {
            forwardedEvents.push(step.value);
            step = await iterator.next();
          }
          return { child: delegatedChild, forwardedEvents, result: step.value };
        });

        const childSettled = await Promise.allSettled(childRuns);
        for (const [, result] of childSettled.entries()) {
          if (result.status === "fulfilled") {
            for (const forwardedEvent of result.value.forwardedEvents) {
              yield forwardedEvent;
            }
          }
        }

        const childOutputs = childSettled.map((result, index) => {
          const childName = delegatedChildren[index]?.name ?? `child-${index + 1}`;
          if (result.status === "rejected") {
            const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
            return { name: childName, output: "", error };
          }

          return {
            name: result.value.child.name,
            output: result.value.result.output,
            error: result.value.result.error,
          };
        });

        const childOutput = childOutputs
          .map((entry) => entry.error
            ? `[${entry.name}]\nERROR: ${entry.error}`
            : `[${entry.name}]\n${entry.output}`)
          .join("\n\n");
        const finishedAt = new Date().toISOString();
        recordAgentResult(state, resultAgentName, childOutput, startedAt, finishedAt);

        yield { type: "agent_complete", agentName: agent.name, output: childOutput };
        await runHooks(agent, "on_complete", state.resources, { ...hookEnv, LOOM_OUTPUT: childOutput.slice(0, 1000) });
        return { output: childOutput };
      }

      if (event.type === "complete") {
        const finishedAt = new Date().toISOString();
        recordAgentResult(state, resultAgentName, event.output, startedAt, finishedAt);

        yield { type: "agent_complete", agentName: agent.name, output: event.output };
        await runHooks(agent, "on_complete", state.resources, { ...hookEnv, LOOM_OUTPUT: event.output.slice(0, 1000) });
        return { output: event.output };
      }

      if (event.type === "error") {
        if (aborted) {
          const finishedAt = new Date().toISOString();
          recordAgentResult(state, resultAgentName, "", startedAt, finishedAt);
          yield { type: "agent_abort", agentName: agent.name };
          return { output: "", error: `Run aborted while ${agent.name} was executing` };
        }

        if (timedOut) {
          const finishedAt = new Date().toISOString();
          recordAgentResult(state, resultAgentName, "", startedAt, finishedAt);
          yield { type: "agent_timeout", agentName: agent.name, timeoutMs };
          yield { type: "agent_error", agentName: agent.name, error: `Timed out after ${timeoutMs}ms`, fatal: false };
          return { output: "", error: `Agent ${agent.name} timed out after ${timeoutMs}ms` };
        }

        const finishedAt = new Date().toISOString();
        recordAgentResult(state, resultAgentName, "", startedAt, finishedAt);
        yield { type: "agent_error", agentName: agent.name, error: event.error, fatal: false };
        await runHooks(agent, "on_error", state.resources, { ...hookEnv, LOOM_ERROR: event.error });
        return { output: "", error: event.error };
      }
    }

    const finishedAt = new Date().toISOString();
    recordAgentResult(state, resultAgentName, "", startedAt, finishedAt);
    yield { type: "agent_complete", agentName: agent.name, output: "" };
    await runHooks(agent, "on_complete", state.resources, hookEnv);
    return { output: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (aborted) {
      const finishedAt = new Date().toISOString();
      recordAgentResult(state, resultAgentName, "", startedAt, finishedAt);
      yield { type: "agent_abort", agentName: agent.name };
      return { output: "", error: message };
    }

    if (timedOut) {
      const finishedAt = new Date().toISOString();
      recordAgentResult(state, resultAgentName, "", startedAt, finishedAt);
      yield { type: "agent_timeout", agentName: agent.name, timeoutMs };
      yield { type: "agent_error", agentName: agent.name, error: `Timed out after ${timeoutMs}ms`, fatal: false };
      return { output: "", error: message };
    }

    yield { type: "agent_error", agentName: agent.name, error: message, fatal: false };
    await runHooks(agent, "on_error", state.resources, { ...hookEnv, LOOM_ERROR: message });
    return { output: "", error: message };
  }
}

// ── Public API ───────────────────────────────────────────────────

export async function* streamRunFlow(
  flowPath: string,
  userPrompt: string,
): AsyncGenerator<RunEvent, void, undefined> {
  const { flow, flowDir } = await loadFlow(flowPath);
  const flowCwd = resolveFlowCwd(flow, flowDir);
  const runId = randomUUID();
  const resources = await loadRunResources();
  const abortController = new AbortController();
  const state: ExecutionState = {
    runId,
    agentResults: [],
    agentNameCounts: new Map<string, number>(),
    resources,
    abortController,
  };

  activeRuns.set(runId, abortController);
  yield { type: "run_start", runId, flowName: flow.name };

  try {
    const result = yield* executeAgent(flow.orchestrator, userPrompt, flow.repo, flowCwd, state);
    const output = result.output;

    persistRun({
      runId,
      flowName: flow.name,
      flowPath,
      userPrompt,
      output,
      agentResults: state.agentResults,
    });

    yield { type: "run_complete", output };
  } catch (error) {
    if (abortController.signal.aborted) {
      yield { type: "run_aborted", runId };
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    yield { type: "run_error", error: message };
    return;
  } finally {
    activeRuns.delete(runId);
  }
}

export async function runFlow(
  flowPath: string,
  userPrompt: string,
): Promise<RunResponse> {
  const { flow, flowDir } = await loadFlow(flowPath);
  const flowCwd = resolveFlowCwd(flow, flowDir);
  const runId = randomUUID();
  const resources = await loadRunResources();
  const abortController = new AbortController();
  const state: ExecutionState = {
    runId,
    agentResults: [],
    agentNameCounts: new Map<string, number>(),
    resources,
    abortController,
  };

  activeRuns.set(runId, abortController);

  try {
    const result = await (async () => {
      const iterator = executeAgent(flow.orchestrator, userPrompt, flow.repo, flowCwd, state);
      let step = await iterator.next();
      while (!step.done) {
        step = await iterator.next();
      }
      return step.value;
    })();
    const output = result.output;

    persistRun({
      runId,
      flowName: flow.name,
      flowPath,
      userPrompt,
      output,
      agentResults: state.agentResults,
    });

    return {
      runId,
      flowName: flow.name,
      output,
      agentResults: state.agentResults,
    };
  } finally {
    activeRuns.delete(runId);
  }
}
