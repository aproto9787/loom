import { z } from "zod";

export const agentTypeSchema = z.enum(["claude-code", "codex"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export const providerAuthStateSchema = z.enum(["ready", "missing", "unknown"]);
export type ProviderAuthState = z.infer<typeof providerAuthStateSchema>;

export interface ProviderProfile {
  id: string;
  kind: AgentType;
  displayName: string;
  command: string;
  version?: string;
  authState: ProviderAuthState;
  configSources: string[];
}

export const providerProfileSchema: z.ZodType<ProviderProfile> = z.object({
  id: z.string().min(1),
  kind: agentTypeSchema,
  displayName: z.string().min(1),
  command: z.string().min(1),
  version: z.string().min(1).optional(),
  authState: providerAuthStateSchema,
  configSources: z.array(z.string().min(1)),
});

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

export type AgentRuntimeMode = "host" | "isolated";
export type AgentResourceApplication = "prompt-only" | "scoped-home";
export type DelegationTransport = "mcp";

export interface AgentRuntimeConfig {
  mode?: AgentRuntimeMode;
  profile?: string;
  applyResources?: AgentResourceApplication;
  delegationTransport?: DelegationTransport;
}

export const agentRuntimeConfigSchema: z.ZodType<AgentRuntimeConfig> = z.object({
  mode: z.enum(["host", "isolated"]).optional(),
  profile: z.string().min(1).optional(),
  applyResources: z.enum(["prompt-only", "scoped-home"]).optional(),
  delegationTransport: z.literal("mcp").optional(),
});

export const ORACLE_ADVISOR_TRIGGERS = [
  "architecture",
  "design",
  "review",
  "release-risk",
  "debate",
  "planning",
] as const;
export type OracleAdvisorTrigger = (typeof ORACLE_ADVISOR_TRIGGERS)[number];

export const ORACLE_ADVISOR_TRIGGER_LABELS: Record<OracleAdvisorTrigger, string> = {
  architecture: "architecture",
  design: "design",
  review: "review",
  "release-risk": "release-risk",
  debate: "debate",
  planning: "planning",
};

export interface OracleAdvisorConfig {
  enabled?: boolean;
  useFor?: OracleAdvisorTrigger[];
  skipTrivial?: boolean;
  useNpxFallback?: boolean;
  recordCalls?: boolean;
}

export const oracleAdvisorTriggerSchema = z.enum(ORACLE_ADVISOR_TRIGGERS);

export const oracleAdvisorConfigSchema: z.ZodType<OracleAdvisorConfig> = z.object({
  enabled: z.boolean().optional(),
  useFor: z.array(oracleAdvisorTriggerSchema).optional(),
  skipTrivial: z.boolean().optional(),
  useNpxFallback: z.boolean().optional(),
  recordCalls: z.boolean().optional(),
});

export const DEFAULT_ORACLE_ADVISOR_CONFIG: Required<OracleAdvisorConfig> = {
  enabled: true,
  useFor: [...ORACLE_ADVISOR_TRIGGERS],
  skipTrivial: true,
  useNpxFallback: true,
  recordCalls: true,
};

export function normalizeOracleAdvisorConfig(config: OracleAdvisorConfig | undefined): Required<OracleAdvisorConfig> {
  const configuredTriggers = config?.useFor;
  const useFor = configuredTriggers === undefined
    ? [...DEFAULT_ORACLE_ADVISOR_CONFIG.useFor]
    : ORACLE_ADVISOR_TRIGGERS.filter((trigger) => configuredTriggers.includes(trigger));

  return {
    enabled: config?.enabled ?? DEFAULT_ORACLE_ADVISOR_CONFIG.enabled,
    useFor,
    skipTrivial: config?.skipTrivial ?? DEFAULT_ORACLE_ADVISOR_CONFIG.skipTrivial,
    useNpxFallback: config?.useNpxFallback ?? DEFAULT_ORACLE_ADVISOR_CONFIG.useNpxFallback,
    recordCalls: config?.recordCalls ?? DEFAULT_ORACLE_ADVISOR_CONFIG.recordCalls,
  };
}

export interface AgentConfig {
  name: string;
  type: AgentType;
  enabled?: boolean;
  role?: string;
  team?: AgentTeamTag[];
  model?: string;
  system?: string;
  flowMdRef?: string;
  description?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  timeout?: number;
  parallel?: boolean;
  delegation?: DelegationRule[];
  mcps?: string[];
  hooks?: string[];
  skills?: string[];
  runtime?: AgentRuntimeConfig;
  oracleAdvisor?: OracleAdvisorConfig;
  agents?: AgentConfig[];
}

export const agentConfigSchema: z.ZodType<AgentConfig> = z.lazy(() => z.object({
  name: z.string().min(1),
  type: agentTypeSchema,
  enabled: z.boolean().optional(),
  role: z.string().min(1).optional(),
  team: z.array(agentTeamTagSchema).optional(),
  model: z.string().min(1).optional(),
  system: z.string().min(1).optional(),
  flowMdRef: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  timeout: z.number().int().positive().optional(),
  parallel: z.boolean().optional(),
  delegation: z.array(delegationRuleSchema).optional(),
  mcps: z.array(z.string().min(1)).optional(),
  hooks: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  runtime: agentRuntimeConfigSchema.optional(),
  oracleAdvisor: oracleAdvisorConfigSchema.optional(),
  agents: z.array(agentConfigSchema).optional(),
}));

export interface TeamDefinition {
  id: string;
  description?: string;
  flowMdRef?: string;
}

export const teamDefinitionSchema: z.ZodType<TeamDefinition> = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  flowMdRef: z.string().min(1).optional(),
});

export interface FlowDefinition {
  version?: string;
  name: string;
  description?: string;
  repo: string;
  flowMd?: string;
  flowMdLibrary?: Record<string, string>;
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
  flowMd: z.string().min(1).optional(),
  flowMdLibrary: z.record(z.string(), z.string()).optional(),
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

// ── Flow validation helpers ───────────────────────────────────────
const VALID_AGENT_TYPES_FOR_VALIDATION = new Set<AgentType>(["claude-code", "codex"]);

function isNonEmptyValidationString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateAgentConfig(agent: AgentConfig, path = "agent"): string[] {
  const errors: string[] = [];

  if (!isNonEmptyValidationString(agent.name)) {
    errors.push(`[${path}.name] name is required`);
  }

  if (!VALID_AGENT_TYPES_FOR_VALIDATION.has(agent.type)) {
    errors.push(`[${path}.type] type must be one of: claude-code, codex`);
  }

  if (agent.system !== undefined && !isNonEmptyValidationString(agent.system)) {
    errors.push(`[${path}.system] system must be a non-empty string when provided`);
  }

  if (agent.runtime?.profile !== undefined && !isNonEmptyValidationString(agent.runtime.profile)) {
    errors.push(`[${path}.runtime.profile] profile must be a non-empty string when provided`);
  }

  if (agent.agents === undefined) {
    return errors;
  }

  if (!Array.isArray(agent.agents)) {
    errors.push(`[${path}.agents] agents must be an array when provided`);
    return errors;
  }

  agent.agents.forEach((child, index) => {
    errors.push(...validateAgentConfig(child, `${path}.agents.${index}`));
  });

  return errors;
}

export function validateFlow(flow: FlowDefinition): string[] {
  const errors: string[] = [];

  if (!isNonEmptyValidationString(flow.name)) {
    errors.push("[flow.name] name is required");
  }

  if (flow.description !== undefined && !isNonEmptyValidationString(flow.description)) {
    errors.push("[flow.description] description must be a non-empty string when provided");
  }

  if (!isNonEmptyValidationString(flow.repo)) {
    errors.push("[flow.repo] repo is required");
  }

  if (!flow.orchestrator) {
    errors.push("[flow.orchestrator] orchestrator is required");
    return errors;
  }

  errors.push(...validateAgentConfig(flow.orchestrator, "orchestrator"));
  return errors;
}
