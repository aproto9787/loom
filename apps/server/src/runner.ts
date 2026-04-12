import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import {
  flowDefinitionSchema,
  type AgentConfig,
  type FlowDefinition,
  type RunAgentResult,
  type RunEvent,
  type RunResponse,
} from "@loom/core";
import { getAgentAdapter } from "@loom/adapters";
import { validateFlow } from "@loom/nodes";
import { persistRun } from "./trace-store.js";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

interface LoadedFlow {
  absolutePath: string;
  flowDir: string;
  flow: FlowDefinition;
}

interface ExecutionState {
  agentResults: RunAgentResult[];
  agentNameCounts: Map<string, number>;
}

function resolveFlowPath(flowPath: string): string {
  return path.isAbsolute(flowPath) ? flowPath : path.resolve(workspaceRoot, flowPath);
}

function resolveFlowCwd(flow: FlowDefinition, flowDir: string): string {
  if (!flow.repo) {
    return flowDir;
  }

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
  state.agentResults.push({
    agentName,
    output,
    startedAt,
    finishedAt,
  });
}

function buildAgentPrompt(agent: AgentConfig, flowRepo: string): string {
  const sections: string[] = [];

  if (agent.system?.trim()) {
    sections.push(agent.system.trim());
  }

  sections.push(`Shared flow repo: ${flowRepo}`);

  if (agent.agents?.length) {
    const children = agent.agents.map((child) => {
      const fields = [
        `name: ${child.name}`,
        `type: ${child.type}`,
      ];
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

export async function loadFlow(flowPath: string): Promise<LoadedFlow> {
  const absolutePath = resolveFlowPath(flowPath);
  const raw = await readFile(absolutePath, "utf8");
  const flow = flowDefinitionSchema.parse(YAML.parse(raw));
  const validationErrors = validateFlow(flow);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }

  return {
    absolutePath,
    flowDir: path.dirname(absolutePath),
    flow,
  };
}

async function* executeAgent(
  agent: AgentConfig,
  input: string,
  flowRepo: string,
  flowCwd: string,
  state: ExecutionState,
): AsyncGenerator<RunEvent, string, undefined> {
  const cwd = flowCwd;
  const adapter = getAgentAdapter(agent.type);
  const configuredAgent: AgentConfig = {
    ...agent,
    system: buildAgentPrompt(agent, flowRepo),
  };
  const resultAgentName = nextResultAgentName(agent.name, state);
  const startedAt = new Date().toISOString();

  yield { type: "agent_start", agentName: agent.name, agentType: agent.type };

  try {
    for await (const event of adapter.spawn(configuredAgent, input, cwd)) {
      if (event.type === "token") {
        yield { type: "agent_token", agentName: agent.name, token: event.content };
        continue;
      }

      if (event.type === "delegate") {
        const child = agent.agents?.find((candidate) => candidate.name === event.childAgent);
        if (!child) {
          throw new Error(`Agent ${agent.name} attempted to delegate to unknown child ${event.childAgent}`);
        }

        yield { type: "agent_delegate", parentAgent: agent.name, childAgent: child.name };
        const childOutput = yield* executeAgent(child, event.reason, flowRepo, flowCwd, state);
        const finishedAt = new Date().toISOString();
        recordAgentResult(state, resultAgentName, childOutput, startedAt, finishedAt);
        yield { type: "agent_complete", agentName: agent.name, output: childOutput };
        return childOutput;
      }

      if (event.type === "complete") {
        const finishedAt = new Date().toISOString();
        recordAgentResult(state, resultAgentName, event.output, startedAt, finishedAt);
        yield { type: "agent_complete", agentName: agent.name, output: event.output };
        return event.output;
      }

      if (event.type === "error") {
        throw new Error(event.error);
      }
    }

    const finishedAt = new Date().toISOString();
    recordAgentResult(state, resultAgentName, "", startedAt, finishedAt);
    yield { type: "agent_complete", agentName: agent.name, output: "" };
    return "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: "agent_error", agentName: agent.name, error: message };
    throw error instanceof Error ? error : new Error(message);
  }
}

export async function* streamRunFlow(
  flowPath: string,
  userPrompt: string,
): AsyncGenerator<RunEvent, void, undefined> {
  const { flow, flowDir } = await loadFlow(flowPath);
  const flowCwd = resolveFlowCwd(flow, flowDir);
  const runId = randomUUID();
  const state: ExecutionState = {
    agentResults: [],
    agentNameCounts: new Map<string, number>(),
  };

  yield { type: "run_start", runId, flowName: flow.name };

  try {
    const output = yield* executeAgent(flow.orchestrator, userPrompt, flow.repo, flowCwd, state);

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
    const message = error instanceof Error ? error.message : String(error);
    yield { type: "run_error", error: message };
    throw error instanceof Error ? error : new Error(message);
  }
}

export async function runFlow(
  flowPath: string,
  userPrompt: string,
): Promise<RunResponse> {
  const { flow, flowDir } = await loadFlow(flowPath);
  const flowCwd = resolveFlowCwd(flow, flowDir);
  const runId = randomUUID();
  const state: ExecutionState = {
    agentResults: [],
    agentNameCounts: new Map<string, number>(),
  };

  const output = await (async () => {
    const iterator = executeAgent(flow.orchestrator, userPrompt, flow.repo, flowCwd, state);
    let step = await iterator.next();
    while (!step.done) {
      step = await iterator.next();
    }
    return step.value;
  })();

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
}
