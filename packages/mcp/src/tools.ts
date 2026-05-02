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
  ];
}
