import { z } from "zod";

export const agentTypeSchema = z.enum(["claude-code", "codex"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

// ── Hook / Skill definitions ─────────────────────────────────────

export type HookEvent = 'on_start' | 'on_complete' | 'on_error' | 'on_delegate';

export interface HookDefinition {
  name: string;
  event: HookEvent;
  command: string;
  description?: string;
}

export const hookEventSchema = z.enum(['on_start', 'on_complete', 'on_error', 'on_delegate']);

export const hookDefinitionSchema: z.ZodType<HookDefinition> = z.object({
  name: z.string().min(1),
  event: hookEventSchema,
  command: z.string().min(1),
  description: z.string().min(1).optional(),
});

export interface SkillDefinition {
  name: string;
  prompt: string;
  description?: string;
}

export const skillDefinitionSchema: z.ZodType<SkillDefinition> = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  description: z.string().min(1).optional(),
});

// ── Agent config ─────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  type: AgentType;
  model?: string;
  system?: string;
  effort?: 'low' | 'medium' | 'high';
  timeout?: number;
  parallel?: boolean;
  mcps?: string[];
  hooks?: string[];
  skills?: string[];
  agents?: AgentConfig[];
}

export const agentConfigSchema: z.ZodType<AgentConfig> = z.lazy(() => z.object({
  name: z.string().min(1),
  type: agentTypeSchema,
  model: z.string().min(1).optional(),
  system: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  timeout: z.number().int().positive().optional(),
  parallel: z.boolean().optional(),
  mcps: z.array(z.string().min(1)).optional(),
  hooks: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  agents: z.array(agentConfigSchema).optional(),
}));

export interface FlowDefinition {
  version?: string;
  name: string;
  description?: string;
  repo: string;
  orchestrator: AgentConfig;
  resources?: {
    mcps?: string[];
    hooks?: string[];
    skills?: string[];
  };
}

export const flowDefinitionSchema: z.ZodType<FlowDefinition> = z.object({
  version: z.string().min(1).default("1").optional(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  repo: z.string().min(1),
  orchestrator: agentConfigSchema,
  resources: z.object({
    mcps: z.array(z.string().min(1)).optional(),
    hooks: z.array(z.string().min(1)).optional(),
    skills: z.array(z.string().min(1)).optional(),
  }).optional(),
});

export const flowSchema = flowDefinitionSchema;

export interface RoleDefinition {
  name: string;
  type: 'claude-code' | 'codex';
  model?: string;
  system: string;
  effort?: 'low' | 'medium' | 'high';
  description?: string;
  mcps?: string[];
}

export const roleDefinitionSchema: z.ZodType<RoleDefinition> = z.object({
  name: z.string().min(1),
  type: agentTypeSchema,
  model: z.string().min(1).optional(),
  system: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  description: z.string().min(1).optional(),
  mcps: z.array(z.string().min(1)).optional(),
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
  | { type: "agent_error"; agentName: string; error: string; fatal?: boolean }
  | { type: "agent_timeout"; agentName: string; timeoutMs: number }
  | { type: "agent_abort"; agentName: string }
  | { type: "agent_delegate"; parentAgent: string; childAgent: string }
  | { type: "run_complete"; output: string }
  | { type: "run_aborted"; runId: string }
  | { type: "run_error"; error: string };
