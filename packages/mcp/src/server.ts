import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  approvalRecordSchema,
  gateRecordSchema,
  rollbackRecordSchema,
  type AgentConfig,
  type ApprovalRecord,
  type GateRecord,
  type RollbackRecord,
} from "@aproto9787/heddle-core";
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

type GovernanceEventType =
  | "gate_record"
  | "manifest_update"
  | "approval_required"
  | "approval_recorded"
  | "rollback_recorded";

interface ManifestUpdate {
  traceId?: string;
  request?: string;
  interpretedGoal?: string;
  riskTier?: "quick" | "code" | "side_effect" | "enterprise";
  governancePack?: string;
  workers?: string[];
  result?: "running" | "pass" | "fail" | "blocked" | "aborted";
  summary?: string;
  updatedAt?: string;
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
    if (name === "heddle_record_gate") {
      return textResult(await this.recordGate(args));
    }
    if (name === "heddle_read_manifest") {
      return textResult(await this.readManifest(args));
    }
    if (name === "heddle_update_manifest") {
      return textResult(await this.updateManifest(args));
    }
    if (name === "heddle_require_approval") {
      return textResult(await this.requireApproval(args));
    }
    if (name === "heddle_record_approval") {
      return textResult(await this.recordApproval(args));
    }
    if (name === "heddle_record_rollback") {
      return textResult(await this.recordRollback(args));
    }
    return textResult(`unknown tool: ${name ?? "<missing>"}`, true);
  }

  private resolveGovernanceContext(args: unknown): { context: HeddleMcpContext; runId: string; serverOrigin: string } {
    const context = buildContext(this.env);
    const object = asObject(args);
    const runId = typeof object.runId === "string" && object.runId.trim()
      ? object.runId.trim()
      : context.runId;
    if (!runId) {
      throw new Error("runId is required; provide runId or set HEDDLE_RUN_ID");
    }
    if (!context.serverOrigin) {
      throw new Error("HEDDLE_SERVER_ORIGIN is required for governance tools");
    }
    return {
      context,
      runId,
      serverOrigin: context.serverOrigin.replace(/\/+$/, ""),
    };
  }

  private async postGovernanceEvent(
    args: unknown,
    type: GovernanceEventType,
    raw: GateRecord | ManifestUpdate | ApprovalRecord | RollbackRecord,
    summary: string,
  ): Promise<unknown> {
    const { context, runId, serverOrigin } = this.resolveGovernanceContext(args);
    const response = await fetch(`${serverOrigin}/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            ts: Date.now(),
            type,
            summary,
            agentName: context.currentAgentName,
            agentDepth: context.parentDepth,
            raw,
          },
        ],
      }),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : {};
    if (!response.ok) {
      const message = typeof payload === "object" && payload !== null && "error" in payload
        ? JSON.stringify((payload as { error: unknown }).error)
        : text;
      throw new Error(`governance event rejected (${response.status}): ${message}`);
    }
    return {
      runId,
      eventType: type,
      raw,
      response: payload,
    };
  }

  private async recordGate(args: unknown): Promise<unknown> {
    const context = buildContext(this.env);
    const object = asObject(args);
    const record = gateRecordSchema.parse({
      gate: object.gate,
      status: object.status,
      reason: object.reason,
      evidence: object.evidence,
      blockers: object.blockers,
      recordedBy: typeof object.recordedBy === "string" ? object.recordedBy : context.currentAgentName,
      recordedAt: new Date().toISOString(),
    });
    return this.postGovernanceEvent(args, "gate_record", record, `gate ${record.gate}: ${record.status}`);
  }

  private async readManifest(args: unknown): Promise<unknown> {
    const { runId, serverOrigin } = this.resolveGovernanceContext(args);
    const response = await fetch(`${serverOrigin}/runs/${encodeURIComponent(runId)}/manifest`);
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : {};
    if (!response.ok) {
      throw new Error(`manifest read failed (${response.status}): ${text}`);
    }
    return payload;
  }

  private parseManifestUpdate(args: unknown): ManifestUpdate {
    const object = asObject(args);
    const update: ManifestUpdate = {};
    for (const key of ["traceId", "request", "interpretedGoal", "governancePack", "summary"] as const) {
      if (typeof object[key] === "string" && object[key].trim()) {
        update[key] = object[key].trim();
      }
    }
    if (typeof object.riskTier === "string") {
      const riskTier = object.riskTier.trim();
      if (!["quick", "code", "side_effect", "enterprise"].includes(riskTier)) {
        throw new Error("riskTier must be one of quick, code, side_effect, enterprise");
      }
      update.riskTier = riskTier as ManifestUpdate["riskTier"];
    }
    if (typeof object.result === "string") {
      const result = object.result.trim();
      if (!["running", "pass", "fail", "blocked", "aborted"].includes(result)) {
        throw new Error("result must be one of running, pass, fail, blocked, aborted");
      }
      update.result = result as ManifestUpdate["result"];
    }
    if (Array.isArray(object.workers)) {
      const workers = object.workers.filter((worker): worker is string => typeof worker === "string" && worker.trim().length > 0)
        .map((worker) => worker.trim());
      if (workers.length !== object.workers.length) {
        throw new Error("workers must contain non-empty strings");
      }
      update.workers = workers;
    }
    update.updatedAt = new Date().toISOString();
    const meaningfulKeys = Object.keys(update).filter((key) => key !== "updatedAt");
    if (meaningfulKeys.length === 0) {
      throw new Error("manifest update must include at least one bounded field");
    }
    return update;
  }

  private async updateManifest(args: unknown): Promise<unknown> {
    const update = this.parseManifestUpdate(args);
    return this.postGovernanceEvent(args, "manifest_update", update, "manifest updated");
  }

  private async requireApproval(args: unknown): Promise<unknown> {
    const context = buildContext(this.env);
    const object = asObject(args);
    const record = approvalRecordSchema.parse({
      id: typeof object.id === "string" && object.id.trim() ? object.id.trim() : randomUUID(),
      gate: object.gate,
      status: "required",
      target: object.target,
      reason: object.reason,
      requestedBy: typeof object.requestedBy === "string" ? object.requestedBy : context.currentAgentName,
      evidence: object.evidence,
      recordedAt: new Date().toISOString(),
    });
    return this.postGovernanceEvent(args, "approval_required", record, `approval required: ${record.target}`);
  }

  private async recordApproval(args: unknown): Promise<unknown> {
    const object = asObject(args);
    const status = object.status;
    if (status !== "approved" && status !== "rejected") {
      throw new Error("status must be approved or rejected");
    }
    const record = approvalRecordSchema.parse({
      id: typeof object.id === "string" && object.id.trim() ? object.id.trim() : randomUUID(),
      gate: object.gate,
      status,
      target: object.target,
      reason: object.reason,
      approver: object.approver,
      approvalText: object.approvalText,
      evidence: object.evidence,
      recordedAt: new Date().toISOString(),
    });
    return this.postGovernanceEvent(args, "approval_recorded", record, `approval ${record.status}: ${record.target}`);
  }

  private async recordRollback(args: unknown): Promise<unknown> {
    const object = asObject(args);
    const record = rollbackRecordSchema.parse({
      id: typeof object.id === "string" && object.id.trim() ? object.id.trim() : randomUUID(),
      gate: object.gate,
      status: typeof object.status === "string" ? object.status : "planned",
      target: object.target,
      rollbackPlan: object.rollbackPlan,
      currentState: object.currentState,
      backupRef: object.backupRef,
      lastSafeCheckpoint: object.lastSafeCheckpoint,
      evidence: object.evidence,
      recordedAt: new Date().toISOString(),
    });
    return this.postGovernanceEvent(args, "rollback_recorded", record, `rollback ${record.status}: ${record.target}`);
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
