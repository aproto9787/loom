import { randomUUID } from "node:crypto";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentConfig } from "@aproto9787/loom-core";
import {
  directChildren,
  findAgentByName,
  loadFlow,
  parseSubagentReport,
  runSubagentTask,
  type RunSubagentTaskOptions,
  type RunSubagentTaskResult,
} from "@aproto9787/loom-runtime";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolCallParams {
  name?: string;
  arguments?: unknown;
}

interface LoomMcpContext {
  flowPath: string;
  cwd: string;
  currentAgentName: string;
  parentDepth: number;
  runId?: string;
  serverOrigin?: string;
  subagentBin: string;
}

interface DelegateArguments {
  agent?: string;
  briefing?: string;
  timeoutSeconds?: number;
  wait?: boolean;
}

interface DelegateManyArguments {
  tasks?: DelegateArguments[];
  timeoutSeconds?: number;
}

interface ReadReportArguments {
  taskId?: string;
}

interface TaskState {
  taskId: string;
  agent: string;
  status: "running" | RunSubagentTaskResult["status"];
  promise: Promise<RunSubagentTaskResult>;
  controller: AbortController;
  result?: RunSubagentTaskResult;
  error?: string;
}

export interface LoomMcpServerOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  delegateRunner?: (options: RunSubagentTaskOptions) => Promise<RunSubagentTaskResult>;
}

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    isError,
  };
}

function errorResponse(id: JsonRpcId | undefined, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

function childNames(children: AgentConfig[]): string[] {
  return children.map((child) => child.name);
}

function slugifyToolName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "agent";
}

function delegateToolName(agentName: string): string {
  return `loom_delegate_${slugifyToolName(agentName)}`;
}

const RESERVED_TOOL_NAMES = new Set([
  "loom_delegate",
  "loom_delegate_many",
  "loom_get_status",
  "loom_read_report",
  "loom_cancel",
]);

function dynamicToolMap(children: AgentConfig[]): Map<string, AgentConfig> {
  const tools = new Map<string, AgentConfig>();
  for (const child of children) {
    const base = delegateToolName(child.name);
    let candidate = base;
    let suffix = 2;
    while (RESERVED_TOOL_NAMES.has(candidate) || tools.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    tools.set(candidate, child);
  }
  return tools;
}

function toolInputSchema(agentEnum: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      agent: { type: "string", enum: agentEnum },
      briefing: { type: "string", minLength: 1 },
      timeoutSeconds: { type: "number", minimum: 1 },
      wait: { type: "boolean" },
    },
    required: ["agent", "briefing"],
    additionalProperties: false,
  };
}

function dynamicDelegateInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      briefing: { type: "string", minLength: 1 },
      timeoutSeconds: { type: "number", minimum: 1 },
      wait: { type: "boolean" },
    },
    required: ["briefing"],
    additionalProperties: false,
  };
}

function buildTools(children: AgentConfig[]): McpTool[] {
  const agents = childNames(children);
  const dynamicTools = [...dynamicToolMap(children)].map(([name, child]) => ({
    name,
    description: `Delegate one task to the direct child agent "${child.name}". ${child.description ?? child.system ?? "Returns the child REPORT."}`,
    inputSchema: dynamicDelegateInputSchema(),
  }));
  return [
    {
      name: "loom_delegate",
      description: "Delegate one task to a direct child agent in the current Loom flow. Returns the child REPORT.",
      inputSchema: toolInputSchema(agents),
    },
    ...dynamicTools,
    {
      name: "loom_delegate_many",
      description: "Delegate multiple independent tasks to direct child agents in parallel.",
      inputSchema: {
        type: "object",
        properties: {
          timeoutSeconds: { type: "number", minimum: 1 },
          tasks: {
            type: "array",
            minItems: 1,
            items: toolInputSchema(agents),
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
    },
    {
      name: "loom_get_status",
      description: "Read the status of a Loom MCP delegation task.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", minLength: 1 },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
    {
      name: "loom_read_report",
      description: "Read the REPORT for a completed Loom MCP delegation task.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", minLength: 1 },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
    {
      name: "loom_cancel",
      description: "Cancel a running Loom MCP delegation task started with wait=false.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", minLength: 1 },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  ];
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildContext(env: NodeJS.ProcessEnv): LoomMcpContext {
  const flowPath = env.LOOM_FLOW_PATH;
  if (!flowPath) {
    throw new Error("LOOM_FLOW_PATH is required for loom mcp");
  }
  const subagentBin = env.LOOM_SUBAGENT_BIN;
  if (!subagentBin) {
    throw new Error("LOOM_SUBAGENT_BIN is required for loom mcp");
  }
  return {
    flowPath,
    cwd: env.LOOM_FLOW_CWD ?? process.cwd(),
    currentAgentName: env.LOOM_AGENT ?? "leader",
    parentDepth: parsePositiveInteger(env.LOOM_PARENT_DEPTH, 0),
    runId: env.LOOM_RUN_ID,
    serverOrigin: env.LOOM_SERVER_ORIGIN,
    subagentBin,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseTimeoutSeconds(object: Record<string, unknown>, fallback: number): number {
  if (object.timeoutSeconds === undefined) return fallback;
  if (typeof object.timeoutSeconds !== "number" || !Number.isFinite(object.timeoutSeconds) || object.timeoutSeconds < 1) {
    throw new Error("timeoutSeconds must be a positive number");
  }
  return object.timeoutSeconds;
}

function parseDelegateArguments(value: unknown, fallbackTimeoutSeconds = 900): Required<DelegateArguments> {
  const object = asObject(value);
  const agent = typeof object.agent === "string" ? object.agent.trim() : "";
  const briefing = typeof object.briefing === "string" ? object.briefing.trim() : "";
  const timeoutSeconds = parseTimeoutSeconds(object, fallbackTimeoutSeconds);
  const wait = typeof object.wait === "boolean" ? object.wait : true;
  if (!agent) throw new Error("agent is required");
  if (!briefing) throw new Error("briefing is required");
  return { agent, briefing, timeoutSeconds, wait };
}

function parseDelegateManyArguments(value: unknown): Required<DelegateManyArguments> {
  const object = asObject(value);
  const timeoutSeconds = parseTimeoutSeconds(object, 900);
  const tasks = Array.isArray(object.tasks)
    ? object.tasks.map((task) => parseDelegateArguments(task, timeoutSeconds))
    : [];
  if (tasks.length === 0) throw new Error("tasks must contain at least one task");
  return { tasks, timeoutSeconds };
}

function parseReadReportArguments(value: unknown): Required<ReadReportArguments> {
  const object = asObject(value);
  const taskId = typeof object.taskId === "string" ? object.taskId.trim() : "";
  if (!taskId) throw new Error("taskId is required");
  return { taskId };
}

export class LoomMcpServer {
  private readonly env: NodeJS.ProcessEnv;
  private readonly delegateRunner: (options: RunSubagentTaskOptions) => Promise<RunSubagentTaskResult>;
  private readonly tasks = new Map<string, TaskState>();

  constructor(options: LoomMcpServerOptions = {}) {
    this.env = options.env ?? process.env;
    this.delegateRunner = options.delegateRunner ?? runSubagentTask;
  }

  async handleRequest(request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
    const method = request.method;
    if (!method) {
      return errorResponse(request.id, -32600, "method is required");
    }
    if (method.startsWith("notifications/")) {
      return undefined;
    }

    try {
      if (method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "loom", version: "0.1.0" },
          },
        };
      }
      if (method === "tools/list") {
        const { children } = await this.loadAgentContext();
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: { tools: buildTools(children) },
        };
      }
      if (method === "tools/call") {
        const params = asObject(request.params) as ToolCallParams;
        const result = await this.callTool(params.name, params.arguments);
        return { jsonrpc: "2.0", id: request.id ?? null, result };
      }
      return errorResponse(request.id, -32601, `unknown method: ${method}`);
    } catch (error) {
      return errorResponse(request.id, -32000, error instanceof Error ? error.message : String(error));
    }
  }

  private async loadAgentContext(): Promise<{ context: LoomMcpContext; selfAgent: AgentConfig; children: AgentConfig[] }> {
    const context = buildContext(this.env);
    const loaded = await loadFlow(context.flowPath);
    const selfAgent = findAgentByName(loaded.flow.orchestrator, context.currentAgentName)
      ?? loaded.flow.orchestrator;
    return {
      context,
      selfAgent,
      children: directChildren(selfAgent),
    };
  }

  private getTask(taskId: string): TaskState {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`unknown taskId: ${taskId}`);
    }
    return task;
  }

  private async callTool(name: string | undefined, args: unknown): Promise<Record<string, unknown>> {
    if (name === "loom_delegate") {
      return textResult(await this.delegate(args));
    }
    if (name === "loom_delegate_many") {
      return textResult(await this.delegateMany(args));
    }
    if (name?.startsWith("loom_delegate_")) {
      const { children } = await this.loadAgentContext();
      const target = dynamicToolMap(children).get(name);
      if (!target) {
        return textResult(`unknown delegation tool: ${name}`, true);
      }
      return textResult(await this.delegate({ ...asObject(args), agent: target.name }));
    }
    if (name === "loom_get_status") {
      const { taskId } = parseReadReportArguments(args);
      const task = this.getTask(taskId);
      return textResult({
        taskId,
        agent: task.agent,
        status: task.status,
        error: task.error,
      });
    }
    if (name === "loom_read_report") {
      const { taskId } = parseReadReportArguments(args);
      const task = this.getTask(taskId);
      return textResult(task.result ?? {
        taskId,
        agent: task.agent,
        status: task.status,
        error: task.error,
      });
    }
    if (name === "loom_cancel") {
      const { taskId } = parseReadReportArguments(args);
      const task = this.getTask(taskId);
      if (task.status === "running") {
        task.controller.abort();
        task.status = "cancelled";
      }
      return textResult({
        taskId,
        agent: task.agent,
        status: task.status,
        cancelled: true,
      });
    }
    return textResult(`unknown tool: ${name ?? "<missing>"}`, true);
  }

  private async delegate(args: unknown): Promise<unknown> {
    const parsed = parseDelegateArguments(args);
    const { context, children } = await this.loadAgentContext();
    const target = children.find((child) => child.name === parsed.agent);
    if (!target) {
      throw new Error(`agent must be one of the current direct children: ${childNames(children).join(", ") || "(none)"}`);
    }
    const controller = new AbortController();
    const promise = this.delegateRunner({
      agent: target,
      parentAgent: context.currentAgentName,
      briefing: parsed.briefing,
      flowPath: context.flowPath,
      cwd: context.cwd,
      runId: context.runId,
      serverOrigin: context.serverOrigin,
      subagentBin: context.subagentBin,
      parentDepth: context.parentDepth,
      timeoutSeconds: parsed.timeoutSeconds,
      signal: controller.signal,
    });
    const taskId = randomUUID();
    const task: TaskState = {
      taskId,
      agent: target.name,
      status: "running",
      promise,
      controller,
    };
    this.tasks.set(taskId, task);
    promise.then((result) => {
      task.result = result;
      task.status = result.status;
    }).catch((error: unknown) => {
      task.status = "error";
      task.error = error instanceof Error ? error.message : String(error);
    });

    if (!parsed.wait) {
      return { taskId, agent: target.name, status: "running" };
    }
    const result = await promise;
    task.result = result;
    task.status = result.status;
    return result;
  }

  private async delegateMany(args: unknown): Promise<unknown> {
    const parsed = parseDelegateManyArguments(args);
    const results = await Promise.all(parsed.tasks.map((task) =>
      this.delegate({
        ...task,
        timeoutSeconds: task.timeoutSeconds ?? parsed.timeoutSeconds,
        wait: true,
      }),
    ));
    return { status: "done", results };
  }
}

export async function runLoomMcpServer(options: LoomMcpServerOptions = {}): Promise<void> {
  const server = new LoomMcpServer(options);
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const rl = readline.createInterface({ input });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      output.write(`${JSON.stringify(errorResponse(null, -32700, "parse error"))}\n`);
      continue;
    }
    const response = await server.handleRequest(request);
    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
