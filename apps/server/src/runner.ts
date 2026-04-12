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
import { getAgentAdapter } from "@loom/adapters";
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
  agentResults: RunAgentResult[];
  agentNameCounts: Map<string, number>;
  resources: RunResources;
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

async function* executeAgent(
  agent: AgentConfig,
  input: string,
  flowRepo: string,
  flowCwd: string,
  state: ExecutionState,
): AsyncGenerator<RunEvent, string, undefined> {
  const adapter = getAgentAdapter(agent.type);
  const configuredAgent: AgentConfig = {
    ...agent,
    system: buildAgentPrompt(agent, flowRepo, state.resources),
  };
  const resultAgentName = nextResultAgentName(agent.name, state);
  const startedAt = new Date().toISOString();
  const hookEnv = { LOOM_AGENT: agent.name, LOOM_AGENT_TYPE: agent.type };

  yield { type: "agent_start", agentName: agent.name, agentType: agent.type };
  await runHooks(agent, "on_start", state.resources, hookEnv);

  try {
    for await (const event of adapter.spawn(configuredAgent, input, flowCwd)) {
      if (event.type === "token") {
        yield { type: "agent_token", agentName: agent.name, token: event.content };
        continue;
      }

      if (event.type === "delegate") {
        const child = agent.agents?.find((c) => c.name === event.childAgent);
        if (!child) {
          throw new Error(`Agent ${agent.name} attempted to delegate to unknown child ${event.childAgent}`);
        }

        yield { type: "agent_delegate", parentAgent: agent.name, childAgent: child.name };
        await runHooks(agent, "on_delegate", state.resources, { ...hookEnv, LOOM_DELEGATE_TO: child.name });

        const childOutput = yield* executeAgent(child, event.reason, flowRepo, flowCwd, state);
        const finishedAt = new Date().toISOString();
        recordAgentResult(state, resultAgentName, childOutput, startedAt, finishedAt);

        yield { type: "agent_complete", agentName: agent.name, output: childOutput };
        await runHooks(agent, "on_complete", state.resources, { ...hookEnv, LOOM_OUTPUT: childOutput.slice(0, 1000) });
        return childOutput;
      }

      if (event.type === "complete") {
        const finishedAt = new Date().toISOString();
        recordAgentResult(state, resultAgentName, event.output, startedAt, finishedAt);

        yield { type: "agent_complete", agentName: agent.name, output: event.output };
        await runHooks(agent, "on_complete", state.resources, { ...hookEnv, LOOM_OUTPUT: event.output.slice(0, 1000) });
        return event.output;
      }

      if (event.type === "error") {
        throw new Error(event.error);
      }
    }

    const finishedAt = new Date().toISOString();
    recordAgentResult(state, resultAgentName, "", startedAt, finishedAt);
    yield { type: "agent_complete", agentName: agent.name, output: "" };
    await runHooks(agent, "on_complete", state.resources, hookEnv);
    return "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: "agent_error", agentName: agent.name, error: message };
    await runHooks(agent, "on_error", state.resources, { ...hookEnv, LOOM_ERROR: message });
    throw error instanceof Error ? error : new Error(message);
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
  const state: ExecutionState = {
    agentResults: [],
    agentNameCounts: new Map<string, number>(),
    resources,
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
  const resources = await loadRunResources();
  const state: ExecutionState = {
    agentResults: [],
    agentNameCounts: new Map<string, number>(),
    resources,
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
