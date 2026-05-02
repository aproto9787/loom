import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { AgentConfig } from "@aproto9787/heddle-core";
import {
  directChildren,
  findAgentByName,
  loadFlow,
  runSubagentTask,
  type RunSubagentTaskOptions,
  type RunSubagentTaskResult,
} from "@aproto9787/heddle-runtime";
import {
  asObject,
  parseDelegateArguments,
  parseDelegateManyArguments,
  parseReadReportArguments,
} from "./arguments.js";
import { buildContext, parsePositiveNumber, type HeddleMcpContext } from "./context.js";
import { errorResponse, textResult, type JsonRpcRequest } from "./json-rpc.js";
import { DEFAULT_SYNC_WAIT_CAP_MS, type TaskState } from "./tasks.js";
import { buildTools, childNames, dynamicToolMap } from "./tools.js";

interface ToolCallParams {
  name?: string;
  arguments?: unknown;
}

export interface HeddleMcpServerOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  delegateRunner?: (options: RunSubagentTaskOptions) => Promise<RunSubagentTaskResult>;
}

export class HeddleMcpServer {
  private readonly env: NodeJS.ProcessEnv;
  private readonly delegateRunner: (options: RunSubagentTaskOptions) => Promise<RunSubagentTaskResult>;
  private readonly tasks = new Map<string, TaskState>();

  constructor(options: HeddleMcpServerOptions = {}) {
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
            serverInfo: { name: "heddle", version: "0.1.0" },
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

  private async loadAgentContext(): Promise<{ context: HeddleMcpContext; selfAgent: AgentConfig; children: AgentConfig[] }> {
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
    if (name === "heddle_delegate") {
      return textResult(await this.delegate(args));
    }
    if (name === "heddle_delegate_many") {
      return textResult(await this.delegateMany(args));
    }
    if (name?.startsWith("heddle_delegate_")) {
      const { children } = await this.loadAgentContext();
      const target = dynamicToolMap(children).get(name);
      if (!target) {
        return textResult(`unknown delegation tool: ${name}`, true);
      }
      return textResult(await this.delegate({ ...asObject(args), agent: target.name, wait: false }, false));
    }
    if (name === "heddle_get_status") {
      const { taskId } = parseReadReportArguments(args);
      const task = this.getTask(taskId);
      return textResult({
        taskId,
        agent: task.agent,
        status: task.status,
        error: task.error,
      });
    }
    if (name === "heddle_read_report") {
      const { taskId } = parseReadReportArguments(args);
      const task = this.getTask(taskId);
      return textResult(task.result ?? {
        taskId,
        agent: task.agent,
        status: task.status,
        error: task.error,
      });
    }
    if (name === "heddle_cancel") {
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

  private async delegate(args: unknown, defaultWait = true): Promise<unknown> {
    const parsed = parseDelegateArguments(args, 900, defaultWait);
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
    const result = await this.waitForTaskResult(task);
    if (!result) {
      return {
        taskId,
        agent: target.name,
        status: "running",
        syncWaitTimedOut: true,
      };
    }
    task.result = result;
    task.status = result.status;
    return result;
  }

  private async waitForTaskResult(task: TaskState): Promise<RunSubagentTaskResult | undefined> {
    const syncWaitCapMs = parsePositiveNumber(this.env.HEDDLE_MCP_SYNC_WAIT_CAP_MS, DEFAULT_SYNC_WAIT_CAP_MS);
    if (syncWaitCapMs <= 0) return undefined;

    let timeout: NodeJS.Timeout | undefined;
    const capped = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), syncWaitCapMs);
      timeout.unref();
    });

    try {
      return await Promise.race([task.promise, capped]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async delegateMany(args: unknown): Promise<unknown> {
    const parsed = parseDelegateManyArguments(args);
    const results = await Promise.all(parsed.tasks.map((task) =>
      this.delegate({
        ...task,
        timeoutSeconds: task.timeoutSeconds ?? parsed.timeoutSeconds,
        wait: task.wait,
      }),
    ));
    const done = results.every((result) => {
      const status = asObject(result).status;
      return status !== "running";
    });
    return {
      status: done ? "done" : "running",
      wait: parsed.wait,
      results,
    };
  }
}
