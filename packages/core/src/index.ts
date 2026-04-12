import { z } from "zod";

export const agentTypeSchema = z.enum(["claude-code", "codex"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export interface AgentConfig {
  name: string;
  type: AgentType;
  repo?: string;
  system?: string;
  agents?: AgentConfig[];
}

export const agentConfigSchema: z.ZodType<AgentConfig> = z.lazy(() => z.object({
  name: z.string().min(1),
  type: agentTypeSchema,
  repo: z.string().min(1).optional(),
  system: z.string().min(1).optional(),
  agents: z.array(agentConfigSchema).optional(),
}));

export interface FlowDefinition {
  name: string;
  description?: string;
  orchestrator: AgentConfig;
}

export const flowDefinitionSchema: z.ZodType<FlowDefinition> = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  orchestrator: agentConfigSchema,
});

export const flowSchema = flowDefinitionSchema;

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
