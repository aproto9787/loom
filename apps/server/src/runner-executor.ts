import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, FlowDefinition, RunAgentResult, RunEvent, RunResponse } from "@loom/core";
import { getAgentAdapter, parseParallelDelegationDirective } from "@loom/adapters";
import { loadFlow } from "./runner.js";
import { runHooks } from "./runner-hook-runner.js";
import {
  createScopedMcpConfig,
  loadRunResources,
  resolveAgentResources,
  type RunResources,
} from "./runner-resource-loader.js";
import { buildConfiguredAgent } from "./runner-prompt-builder.js";
import { persistRun } from "./trace-store.js";

const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const activeRuns = new Map<string, AbortController>();

export interface ExecutionState {
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
  flow: FlowDefinition,
  input: string,
  flowRepo: string,
  flowCwd: string,
  state: ExecutionState,
): AsyncGenerator<RunEvent, AgentExecutionResult, undefined> {
  const adapter = getAgentAdapter(agent.type);
  const configuredAgent = buildConfiguredAgent(agent, flow, flowRepo, state.resources, state.resources.roles);
  const resultAgentName = nextResultAgentName(agent.name, state);
  const startedAt = new Date().toISOString();
  const scopedResources = resolveAgentResources(agent, flow);
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "loom-agent-home-"));
  const scopedMcpConfigPath = await createScopedMcpConfig(agent, flow, isolatedHome);
  const hookEnv = {
    LOOM_AGENT: agent.name,
    LOOM_AGENT_TYPE: agent.type,
    ...(scopedMcpConfigPath ? { LOOM_MCP_CONFIG_PATH: scopedMcpConfigPath } : {}),
  };
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
      env: scopedMcpConfigPath ? { LOOM_MCP_CONFIG_PATH: scopedMcpConfigPath } : undefined,
      isolatedHome,
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
        const child = agent.agents?.find((candidate) => candidate.name === event.childAgent);
        if (!child) {
          throw new Error(`Agent ${agent.name} attempted to delegate to unknown child ${event.childAgent}`);
        }

        const delegatedChildren = [child];
        const parallelSiblings = agent.parallel ? childAgents.filter((candidate) => candidate.name !== child.name) : [];
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

        await runHooks(agent, "on_delegate", state.resources, {
          ...hookEnv,
          LOOM_DELEGATE_TO: delegatedChildren.map((entry) => entry.name).join(","),
        });

        const childRuns = delegatedChildren.map(async (delegatedChild) => {
          const childReason = delegatedChild.name === child.name
            ? event.reason
            : parallelDelegations?.find((entry: { childAgent: string; reason: string }) => entry.childAgent === delegatedChild.name)?.reason ?? event.reason;
          const iterator = executeAgent(delegatedChild, flow, childReason, flowRepo, flowCwd, state);
          const forwardedEvents: RunEvent[] = [];
          let step = await iterator.next();
          while (!step.done) {
            forwardedEvents.push(step.value);
            step = await iterator.next();
          }
          return { child: delegatedChild, forwardedEvents, result: step.value };
        });

        const childSettled = await Promise.allSettled(childRuns);
        for (const result of childSettled) {
          if (result.status === "fulfilled") {
            for (const forwardedEvent of result.value.forwardedEvents) {
              yield forwardedEvent;
            }
          }
        }

        const childOutput = childSettled
          .map((result, index) => {
            const childName = delegatedChildren[index]?.name ?? `child-${index + 1}`;
            if (result.status === "rejected") {
              const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
              return `[${childName}]\nERROR: ${error}`;
            }
            return result.value.result.error
              ? `[${result.value.child.name}]\nERROR: ${result.value.result.error}`
              : `[${result.value.child.name}]\n${result.value.result.output}`;
          })
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
  } finally {
    if (scopedMcpConfigPath) {
      await rm(path.dirname(scopedMcpConfigPath), { recursive: true, force: true }).catch(() => undefined);
    }
    if (isolatedHome) {
      await rm(isolatedHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

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
    const result = yield* executeAgent(flow.orchestrator, flow, userPrompt, flow.repo, flowCwd, state);
    persistRun({
      runId,
      flowName: flow.name,
      flowPath,
      userPrompt,
      output: result.output,
      status: result.error ? "failed" : "success",
      source: "server",
      agentResults: state.agentResults,
    });

    if (result.error) {
      yield { type: "run_error", error: result.error };
      return;
    }

    yield { type: "run_complete", output: result.output };
  } catch (error) {
    if (abortController.signal.aborted) {
      persistRun({
        runId,
        flowName: flow.name,
        flowPath,
        userPrompt,
        output: "",
        status: "aborted",
        source: "server",
      agentResults: state.agentResults,
      });
      yield { type: "run_aborted", runId };
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    persistRun({
      runId,
      flowName: flow.name,
      flowPath,
      userPrompt,
      output: "",
      status: "failed",
      source: "server",
      agentResults: state.agentResults,
    });
    yield { type: "run_error", error: message };
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
    const iterator = executeAgent(flow.orchestrator, flow, userPrompt, flow.repo, flowCwd, state);
    let step = await iterator.next();
    while (!step.done) {
      step = await iterator.next();
    }
    const result = step.value;

    persistRun({
      runId,
      flowName: flow.name,
      flowPath,
      userPrompt,
      output: result.output,
      status: result.error ? "failed" : "success",
      source: "server",
      agentResults: state.agentResults,
    });

    if (result.error) {
      throw new Error(result.error);
    }

    return {
      runId,
      flowName: flow.name,
      output: result.output,
      agentResults: state.agentResults,
    };
  } finally {
    activeRuns.delete(runId);
  }
}
