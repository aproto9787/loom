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

export interface DelegationRule {
  to: string;
  when: string;
}

export const delegationRuleSchema: z.ZodType<DelegationRule> = z.object({
  to: z.string().min(1),
  when: z.string().min(1),
});

export interface AgentTeamTag {
  id: string;
  role?: string;
}

export const agentTeamTagSchema: z.ZodType<AgentTeamTag> = z.object({
  id: z.string().min(1),
  role: z.string().min(1).optional(),
});

export interface AgentConfig {
  name: string;
  type: AgentType;
  role?: string;
  team?: AgentTeamTag[];
  model?: string;
  system?: string;
  claudeMdRef?: string;
  description?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  timeout?: number;
  parallel?: boolean;
  delegation?: DelegationRule[];
  mcps?: string[];
  hooks?: string[];
  skills?: string[];
  agents?: AgentConfig[];
}

export const agentConfigSchema: z.ZodType<AgentConfig> = z.lazy(() => z.object({
  name: z.string().min(1),
  type: agentTypeSchema,
  role: z.string().min(1).optional(),
  team: z.array(agentTeamTagSchema).optional(),
  model: z.string().min(1).optional(),
  system: z.string().min(1).optional(),
  claudeMdRef: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  timeout: z.number().int().positive().optional(),
  parallel: z.boolean().optional(),
  delegation: z.array(delegationRuleSchema).optional(),
  mcps: z.array(z.string().min(1)).optional(),
  hooks: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  agents: z.array(agentConfigSchema).optional(),
}));

export interface TeamDefinition {
  id: string;
  description?: string;
  claudeMdRef?: string;
}

export const teamDefinitionSchema: z.ZodType<TeamDefinition> = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  claudeMdRef: z.string().min(1).optional(),
});

export interface FlowDefinition {
  version?: string;
  name: string;
  description?: string;
  repo: string;
  claudeMd?: string;
  claudeMdLibrary?: Record<string, string>;
  teams?: TeamDefinition[];
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
  claudeMd: z.string().min(1).optional(),
  claudeMdLibrary: z.record(z.string(), z.string()).optional(),
  teams: z.array(teamDefinitionSchema).optional(),
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
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  description?: string;
  mcps?: string[];
}

export const roleDefinitionSchema: z.ZodType<RoleDefinition> = z.object({
  name: z.string().min(1),
  type: agentTypeSchema,
  model: z.string().min(1).optional(),
  system: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  description: z.string().min(1).optional(),
  mcps: z.array(z.string().min(1)).optional(),
});

export interface RunAgentResult {
  agentName: string;
  output: string;
  startedAt?: string;
  finishedAt?: string;
}

export type TimelineEventType = "user" | "assistant" | "tool_use" | "tool_result" | "error";

export interface TimelineEvent {
  runId: string;
  ts: number;
  type: TimelineEventType;
  summary?: string;
  toolName?: string;
  agentName?: string;
  agentDepth?: number;
  parentAgent?: string;
  agentKind?: string;
  raw?: unknown;
}

export type RunStatus = "success" | "failed" | "aborted" | "running" | "done" | "error" | "stale";
export type RunSource = "server" | "cli";

export interface RunSummary {
  runId: string;
  flowName: string;
  status: RunStatus;
  source: RunSource;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  agentCount: number;
  cwd?: string | null;
  agentType?: AgentType;
  lastEventAt?: number;
  eventCount?: number;
  latestActivity?: string;
  activeAgent?: string;
}

export interface RunRecord {
  runId: string;
  flowName: string;
  flowPath: string;
  userPrompt: string;
  output: string;
  status: RunStatus;
  source: RunSource;
  exitCode?: number;
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
  agentResults: RunAgentResult[];
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
