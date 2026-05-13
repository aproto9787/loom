import type { AgentConfig } from "@aproto9787/heddle-core";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function childNames(children: AgentConfig[]): string[] {
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
  return `heddle_delegate_${slugifyToolName(agentName)}`;
}

const RESERVED_TOOL_NAMES = new Set([
  "heddle_delegate",
  "heddle_delegate_many",
  "heddle_get_status",
  "heddle_read_report",
  "heddle_cancel",
  "heddle_record_gate",
  "heddle_read_manifest",
  "heddle_update_manifest",
  "heddle_require_approval",
  "heddle_record_approval",
  "heddle_record_rollback",
]);

export function dynamicToolMap(children: AgentConfig[]): Map<string, AgentConfig> {
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
      wait: {
        type: "boolean",
        description: "Ignored for agent-specific tools; these always return a taskId immediately to avoid MCP client call timeouts.",
      },
    },
    required: ["briefing"],
    additionalProperties: false,
  };
}

export function buildTools(children: AgentConfig[]): McpTool[] {
  const agents = childNames(children);
  const dynamicTools = [...dynamicToolMap(children)].map(([name, child]) => ({
    name,
    description: `Start one task on the direct child agent "${child.name}". Always returns a taskId immediately; poll status/report tools for completion. ${child.description ?? child.system ?? ""}`.trim(),
    inputSchema: dynamicDelegateInputSchema(),
  }));
  return [
    {
      name: "heddle_delegate",
      description: "Delegate one task to a direct child agent in the current Heddle flow. Returns the child REPORT.",
      inputSchema: toolInputSchema(agents),
    },
    ...dynamicTools,
    {
      name: "heddle_delegate_many",
      description: "Start multiple independent child-agent tasks in parallel. By default this returns taskIds immediately; poll status/report tools for completion.",
      inputSchema: {
        type: "object",
        properties: {
          timeoutSeconds: { type: "number", minimum: 1 },
          wait: {
            type: "boolean",
            description: "Wait for all child REPORTs before returning. Defaults to false to avoid MCP client tool-call timeouts.",
          },
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
      name: "heddle_get_status",
      description: "Read the status of a Heddle MCP delegation task.",
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
      name: "heddle_read_report",
      description: "Read the REPORT for a completed Heddle MCP delegation task.",
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
      name: "heddle_cancel",
      description: "Cancel a running Heddle MCP delegation task started with wait=false.",
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
      name: "heddle_record_gate",
      description: "Record a typed governance gate result for the current Heddle run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
          gate: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["pending", "pass", "fail", "blocked", "skipped"] },
          reason: { type: "string", minLength: 1 },
          evidence: { type: "array", items: { type: "string", minLength: 1 } },
          blockers: { type: "array", items: { type: "string", minLength: 1 } },
          recordedBy: { type: "string", minLength: 1 },
        },
        required: ["gate", "status", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "heddle_read_manifest",
      description: "Read the reconstructed governance manifest for the current Heddle run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "heddle_update_manifest",
      description: "Record a bounded governance manifest update for the current Heddle run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
          traceId: { type: "string", minLength: 1 },
          request: { type: "string", minLength: 1 },
          interpretedGoal: { type: "string", minLength: 1 },
          riskTier: { type: "string", enum: ["quick", "code", "side_effect", "enterprise"] },
          governancePack: { type: "string", minLength: 1 },
          workers: { type: "array", items: { type: "string", minLength: 1 } },
          result: { type: "string", enum: ["running", "pass", "fail", "blocked", "aborted"] },
          summary: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "heddle_require_approval",
      description: "Record that explicit approval is required before a guarded side effect can proceed.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 },
          gate: { type: "string", minLength: 1 },
          target: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
          requestedBy: { type: "string", minLength: 1 },
          evidence: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
    {
      name: "heddle_record_approval",
      description: "Record explicit approval or rejection evidence for a guarded side effect.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 },
          gate: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["approved", "rejected"] },
          target: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
          approver: { type: "string", minLength: 1 },
          approvalText: { type: "string", minLength: 1 },
          evidence: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["status", "target"],
        additionalProperties: false,
      },
    },
    {
      name: "heddle_record_rollback",
      description: "Record rollback evidence for a guarded side effect.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 },
          gate: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["planned", "verified", "executed", "failed"] },
          target: { type: "string", minLength: 1 },
          rollbackPlan: { type: "string", minLength: 1 },
          currentState: { type: "string", minLength: 1 },
          backupRef: { type: "string", minLength: 1 },
          lastSafeCheckpoint: { type: "string", minLength: 1 },
          evidence: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["target", "rollbackPlan"],
        additionalProperties: false,
      },
    },
  ];
}
