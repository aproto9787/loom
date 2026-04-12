import { z } from "zod";

export const agentTypeSchema = z.enum(["claude-code", "codex"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export interface AgentConfig {
  name: string;
  type: AgentType;
  model?: string;
  system?: string;
  effort?: 'low' | 'medium' | 'high';
  agents?: AgentConfig[];
}

export const agentConfigSchema: z.ZodType<AgentConfig> = z.lazy(() => z.object({
  name: z.string().min(1),
  type: agentTypeSchema,
  model: z.string().min(1).optional(),
  system: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  agents: z.array(agentConfigSchema).optional(),
}));

export interface FlowDefinition {
  name: string;
  description?: string;
  repo: string;
  orchestrator: AgentConfig;
}

export const flowDefinitionSchema: z.ZodType<FlowDefinition> = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  repo: z.string().min(1),
  orchestrator: agentConfigSchema,
});

export const flowSchema = flowDefinitionSchema;

export interface RoleDefinition {
  name: string;
  type: 'claude-code' | 'codex';
  model?: string;
  system: string;
  effort?: 'low' | 'medium' | 'high';
  description?: string;
}

export const roleDefinitionSchema: z.ZodType<RoleDefinition> = z.object({
  name: z.string().min(1),
  type: agentTypeSchema,
  model: z.string().min(1).optional(),
  system: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  description: z.string().min(1).optional(),
});

export interface RunAgentResult {
  agentName: string;
  output: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RunRequest {
  flowPath: string;
  userPrompt: string;
}

export interface RunResponse {
  runId: string;
  flowName: string;
  output: string;
  agentResults: RunAgentResult[];
}

export type RunEvent =
  | { type: "run_start"; runId: string; flowName: string }
  | { type: "agent_start"; agentName: string; agentType: AgentType }
  | { type: "agent_token"; agentName: string; token: string }
  | { type: "agent_complete"; agentName: string; output: string }
  | { type: "agent_error"; agentName: string; error: string }
  | { type: "agent_delegate"; parentAgent: string; childAgent: string }
  | { type: "run_complete"; output: string }
  | { type: "run_error"; error: string };
