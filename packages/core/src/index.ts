import { z } from "zod";

export const agentTypeSchema = z.enum(["codex"]);
export type AgentType = z.infer<typeof agentTypeSchema>;
const CODEX_DEFAULT_MODEL = "gpt-5.5";
const CODEX_DEFAULT_PROFILE = "codex-default";

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

// ── Risk-tier governance contracts ───────────────────────────────

export const riskTierSchema = z.enum(["quick", "code", "side_effect", "enterprise"]);
export type RiskTier = z.infer<typeof riskTierSchema>;

export const gateStatusSchema = z.enum(["pending", "pass", "fail", "blocked", "skipped"]);
export type GateStatus = z.infer<typeof gateStatusSchema>;

export const approvalStatusSchema = z.enum(["required", "approved", "rejected"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const rollbackStatusSchema = z.enum(["planned", "verified", "executed", "failed"]);
export type RollbackStatus = z.infer<typeof rollbackStatusSchema>;

export interface GovernancePack {
  tier: RiskTier;
  requiredGates: string[];
  optionalGates?: string[];
  description?: string;
}

export const governancePackSchema: z.ZodType<GovernancePack> = z.object({
  tier: riskTierSchema,
  requiredGates: z.array(z.string().min(1)),
  optionalGates: z.array(z.string().min(1)).optional(),
  description: z.string().min(1).optional(),
});

export interface GovernanceConfig {
  defaultTier?: RiskTier;
  defaultPack?: string;
  packs?: Record<string, GovernancePack>;
}

export const governanceConfigSchema: z.ZodType<GovernanceConfig> = z.object({
  defaultTier: riskTierSchema.optional(),
  defaultPack: z.string().min(1).optional(),
  packs: z.record(z.string().min(1), governancePackSchema).optional(),
});

export interface GateRecord {
  gate: string;
  status: GateStatus;
  reason: string;
  evidence?: string[];
  blockers?: string[];
  recordedBy?: string;
  recordedAt?: string;
}

export const gateRecordSchema: z.ZodType<GateRecord> = z.object({
  gate: z.string().min(1),
  status: gateStatusSchema,
  reason: z.string().min(1),
  evidence: z.array(z.string().min(1)).optional(),
  blockers: z.array(z.string().min(1)).optional(),
  recordedBy: z.string().min(1).optional(),
  recordedAt: z.string().min(1).optional(),
});

export interface ApprovalRecord {
  id?: string;
  gate?: string;
  status: ApprovalStatus;
  target: string;
  reason?: string;
  requestedBy?: string;
  approver?: string;
  approvalText?: string;
  evidence?: string[];
  recordedAt?: string;
}

export const approvalRecordSchema: z.ZodType<ApprovalRecord> = z.object({
  id: z.string().min(1).optional(),
  gate: z.string().min(1).optional(),
  status: approvalStatusSchema,
  target: z.string().min(1),
  reason: z.string().min(1).optional(),
  requestedBy: z.string().min(1).optional(),
  approver: z.string().min(1).optional(),
  approvalText: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1)).optional(),
  recordedAt: z.string().min(1).optional(),
});

export interface RollbackRecord {
  id?: string;
  gate?: string;
  status: RollbackStatus;
  target: string;
  rollbackPlan: string;
  currentState?: string;
  backupRef?: string;
  lastSafeCheckpoint?: string;
  evidence?: string[];
  recordedAt?: string;
}

export const rollbackRecordSchema: z.ZodType<RollbackRecord> = z.object({
  id: z.string().min(1).optional(),
  gate: z.string().min(1).optional(),
  status: rollbackStatusSchema,
  target: z.string().min(1),
  rollbackPlan: z.string().min(1),
  currentState: z.string().min(1).optional(),
  backupRef: z.string().min(1).optional(),
  lastSafeCheckpoint: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1)).optional(),
  recordedAt: z.string().min(1).optional(),
});

export const runManifestResultSchema = z.enum(["running", "pass", "fail", "blocked", "aborted"]);
export type RunManifestResult = z.infer<typeof runManifestResultSchema>;

export interface RunManifest {
  runId?: string;
  traceId?: string;
  request: string;
  interpretedGoal: string;
  riskTier: RiskTier;
  governancePack: string;
  workers: string[];
  gates: GateRecord[];
  approvals?: ApprovalRecord[];
  rollbacks?: RollbackRecord[];
  result: RunManifestResult;
  summary?: string;
  updatedAt?: string;
}

export const runManifestSchema: z.ZodType<RunManifest> = z.object({
  runId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  request: z.string().min(1),
  interpretedGoal: z.string().min(1),
  riskTier: riskTierSchema,
  governancePack: z.string().min(1),
  workers: z.array(z.string().min(1)),
  gates: z.array(gateRecordSchema),
  approvals: z.array(approvalRecordSchema).optional(),
  rollbacks: z.array(rollbackRecordSchema).optional(),
  result: runManifestResultSchema,
  summary: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
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
  governance?: GovernanceConfig;
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
  governance: governanceConfigSchema.optional(),
  resources: z.object({
    mcps: z.array(z.string().min(1)).optional(),
    hooks: z.array(z.string().min(1)).optional(),
    skills: z.array(z.string().min(1)).optional(),
  }).optional(),
});

export const flowSchema = flowDefinitionSchema;

export interface RoleDefinition {
  name: string;
  type: AgentType;
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

export interface LegacyMigrationNote {
  path: string;
  from: string;
  to: string;
  message: string;
}

export interface LegacyMigrationResult {
  value: unknown;
  notes: LegacyMigrationNote[];
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneUnknown);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneUnknown(entry)]));
  }
  return value;
}

function pushLegacyNote(
  notes: LegacyMigrationNote[],
  path: string,
  from: string,
  to: string,
  message: string,
): void {
  notes.push({ path, from, to, message });
}

function migrateLegacyAgentRecord(record: Record<string, unknown>, path: string, notes: LegacyMigrationNote[]): void {
  if (record.type === "claude-code") {
    record.type = "codex";
    pushLegacyNote(
      notes,
      `${path}.type`,
      "claude-code",
      "codex",
      "Legacy claude-code agent type was converted to codex.",
    );
  }

  if (isRecord(record.runtime) && record.runtime.profile === "claude-default") {
    record.runtime.profile = CODEX_DEFAULT_PROFILE;
    pushLegacyNote(
      notes,
      `${path}.runtime.profile`,
      "claude-default",
      CODEX_DEFAULT_PROFILE,
      "Legacy Claude provider profile was converted to the Codex default profile.",
    );
  }

  if (typeof record.model === "string" && record.model.startsWith("claude-")) {
    const oldModel = record.model;
    record.model = CODEX_DEFAULT_MODEL;
    pushLegacyNote(
      notes,
      `${path}.model`,
      oldModel,
      CODEX_DEFAULT_MODEL,
      "Legacy Claude model was converted to the Codex default model.",
    );
  }

  if (Array.isArray(record.agents)) {
    record.agents.forEach((child, index) => {
      if (isRecord(child)) {
        migrateLegacyAgentRecord(child, `${path}.agents.${index}`, notes);
      }
    });
  }
}

export function migrateLegacyFlowDefinitionInput(input: unknown): LegacyMigrationResult {
  const value = cloneUnknown(input);
  const notes: LegacyMigrationNote[] = [];

  if (isRecord(value) && isRecord(value.orchestrator)) {
    migrateLegacyAgentRecord(value.orchestrator, "orchestrator", notes);
  }

  return { value, notes, changed: notes.length > 0 };
}

export function migrateLegacyRoleDefinitionInput(input: unknown): LegacyMigrationResult {
  const value = cloneUnknown(input);
  const notes: LegacyMigrationNote[] = [];

  if (isRecord(value)) {
    migrateLegacyAgentRecord(value, "role", notes);
  }

  return { value, notes, changed: notes.length > 0 };
}

export interface RunAgentResult {
  agentName: string;
  output: string;
  startedAt?: string;
  finishedAt?: string;
}

export type TimelineEventType =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "error"
  | "gate_record"
  | "manifest_update"
  | "approval_required"
  | "approval_recorded"
  | "rollback_recorded";

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
const VALID_AGENT_TYPES_FOR_VALIDATION = new Set<AgentType>(["codex"]);

function isNonEmptyValidationString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateAgentConfig(agent: AgentConfig, path = "agent"): string[] {
  const errors: string[] = [];

  if (!isNonEmptyValidationString(agent.name)) {
    errors.push(`[${path}.name] name is required`);
  }

  if (!VALID_AGENT_TYPES_FOR_VALIDATION.has(agent.type)) {
    errors.push(`[${path}.type] type must be codex`);
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
