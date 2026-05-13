import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import YAML from "yaml";
import * as HeddleCore from "@aproto9787/heddle-core";
import {
  approvalRecordSchema,
  flowSchema,
  gateRecordSchema,
  hookDefinitionSchema,
  rollbackRecordSchema,
  roleDefinitionSchema,
  runManifestResultSchema,
  riskTierSchema,
  skillDefinitionSchema,
  validateFlow,
  type ApprovalRecord,
  type GateRecord,
  type RollbackRecord,
  type RunManifest,
  type RunManifestResult,
  type RunStatus,
  type RiskTier,
} from "@aproto9787/heddle-core";
import { discoverProviderProfiles } from "@aproto9787/heddle-runtime";
import type { PersistedRunEvent } from "./trace-store.js";
import { stringifyFlow } from "./flow-writer.js";
import { abortLocalCliRun, startLocalCliRun } from "./local-cli-runner.js";
import {
  appendRunEvent,
  createRunRecord,
  getRun,
  listRunEvents,
  listRuns,
  markStaleRuns,
  updateRunRecord,
} from "./trace-store.js";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const allowedFlowDir = path.join(workspaceRoot, "examples");
const rolesDir = path.join(workspaceRoot, "roles");
const hooksDir = path.join(workspaceRoot, "hooks");
const skillsDir = path.join(workspaceRoot, "skills");

type LegacyMigrationNote = string;

function isAllowedFlowPath(flowPath: string): boolean {
  if (path.isAbsolute(flowPath)) {
    return false;
  }

  const absolutePath = path.resolve(workspaceRoot, flowPath);
  return absolutePath.startsWith(`${allowedFlowDir}${path.sep}`);
}

function isYamlFlowPath(flowPath: string): boolean {
  return flowPath.endsWith(".yaml");
}

function flattenValidationError(error: z.ZodError) {
  return error.flatten();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasLegacyAgentType(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as { type?: unknown }).type === "claude-code") return true;
  if ((value as { agentType?: unknown }).agentType === "claude-code") return true;
  if (Array.isArray(value)) return value.some((entry) => hasLegacyAgentType(entry));
  return Object.values(value as Record<string, unknown>).some((entry) => hasLegacyAgentType(entry));
}

function migrationNotesFrom(value: unknown): LegacyMigrationNote[] {
  if (!value || typeof value !== "object") return [];
  const notes = (value as Record<string, unknown>).notes ?? (value as Record<string, unknown>).migrationNotes;
  if (!Array.isArray(notes)) return [];
  return notes
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object") return "";
      const note = entry as { path?: unknown; from?: unknown; to?: unknown; message?: unknown };
      const pathLabel = typeof note.path === "string" ? note.path : "legacy";
      const from = typeof note.from === "string" ? note.from : undefined;
      const to = typeof note.to === "string" ? note.to : undefined;
      const message = typeof note.message === "string" ? note.message : undefined;
      return [pathLabel, from && to ? `${from} -> ${to}` : undefined, message].filter(Boolean).join(": ");
    })
    .filter((entry) => entry.trim().length > 0);
}

function migrateAgentRecord(value: unknown, pathLabel: string, notes: LegacyMigrationNote[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const agent = { ...(value as Record<string, unknown>) };
  if (agent.type === "claude-code") {
    agent.type = "codex";
    notes.push(`${pathLabel}.type claude-code -> codex`);
  }
  if (agent.type === "codex") {
    const runtime = agent.runtime && typeof agent.runtime === "object"
      ? { ...(agent.runtime as Record<string, unknown>) }
      : {};
    if (runtime.profile === undefined || runtime.profile === "claude-default") {
      runtime.profile = "codex-default";
      notes.push(`${pathLabel}.runtime.profile -> codex-default`);
    }
    if (runtime.mode === undefined) runtime.mode = "host";
    if (runtime.applyResources === undefined) runtime.applyResources = "prompt-only";
    if (runtime.delegationTransport === undefined) runtime.delegationTransport = "mcp";
    agent.runtime = runtime;
    if (agent.model === undefined || (typeof agent.model === "string" && agent.model.startsWith("claude-"))) {
      agent.model = "gpt-5.5";
      notes.push(`${pathLabel}.model -> gpt-5.5`);
    }
  }
  if (Array.isArray(agent.agents)) {
    agent.agents = agent.agents.map((child, index) => migrateAgentRecord(child, `${pathLabel}.agents.${index}`, notes));
  }
  return agent;
}

function migrateLegacyFlowDefinitionInput(value: unknown): { value: unknown; notes: LegacyMigrationNote[] } {
  if (!hasLegacyAgentType(value)) return { value, notes: [] };
  const helper = (HeddleCore as Record<string, unknown>).migrateLegacyFlowDefinitionInput;
  if (typeof helper === "function") {
    try {
      const migrated = helper(cloneJson(value)) as { value?: unknown; notes?: unknown };
      return {
        value: migrated.value ?? migrated,
        notes: migrationNotesFrom(migrated).length > 0
          ? migrationNotesFrom(migrated)
          : ["core legacy migration helper applied"],
      };
    } catch {
      // Fall through to the local compatibility migration.
    }
  }
  const notes: LegacyMigrationNote[] = ["core legacy migration helper unavailable; applied built-in Codex migration"];
  const flow = { ...(value as Record<string, unknown>) };
  if (flow.orchestrator) {
    flow.orchestrator = migrateAgentRecord(flow.orchestrator, "orchestrator", notes);
  }
  return { value: flow, notes };
}

function migrateLegacyRoleDefinitionInput(value: unknown): { value: unknown; notes: LegacyMigrationNote[] } {
  if (!hasLegacyAgentType(value)) return { value, notes: [] };
  const helper = (HeddleCore as Record<string, unknown>).migrateLegacyRoleDefinitionInput;
  if (typeof helper === "function") {
    try {
      const migrated = helper(cloneJson(value)) as { value?: unknown; notes?: unknown };
      return {
        value: migrated.value ?? migrated,
        notes: migrationNotesFrom(migrated).length > 0
          ? migrationNotesFrom(migrated)
          : ["core legacy migration helper applied"],
      };
    } catch {
      // Fall through to the local compatibility migration.
    }
  }
  const notes: LegacyMigrationNote[] = ["core legacy migration helper unavailable; applied built-in Codex migration"];
  return { value: migrateAgentRecord(value, "role", notes), notes };
}

function withMigrationNotes<T extends Record<string, unknown>>(payload: T, notes: LegacyMigrationNote[]): T | (T & { migrationNotes: LegacyMigrationNote[] }) {
  return notes.length > 0 ? { ...payload, migrationNotes: notes } : payload;
}

function legacyAgentTypeNotes(value: unknown): LegacyMigrationNote[] {
  return value === "claude-code" ? ["agentType claude-code -> codex"] : [];
}

function logMigrationNotes(logger: { warn: (obj: object, msg: string) => void }, scope: string, notes: LegacyMigrationNote[]): void {
  if (notes.length > 0) {
    logger.warn({ scope, migrationNotes: notes }, "migrated legacy Claude configuration to Codex");
  }
}

const flowPathSchema = z
  .string()
  .min(1)
  .refine(isAllowedFlowPath, {
    message: "path must stay within examples/",
  })
  .refine(isYamlFlowPath, {
    message: "path must end with .yaml",
  });

const runRequestSchema = z.object({
  flowPath: flowPathSchema,
  userPrompt: z.string().min(1),
});

const runsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().optional(),
  status: z.enum(["success", "failed", "aborted", "running", "done", "error", "stale"]).optional(),
});

const registerRunSchema = z.object({
  runId: z.string().min(1),
  flowPath: z.string().min(1),
  flowName: z.string().min(1),
  agentType: z.preprocess((value) => value === "claude-code" ? "codex" : value, z.literal("codex")),
  startTime: z.string().datetime(),
  source: z.literal("cli"),
  cwd: z.string().optional(),
  userPrompt: z.string().optional(),
});

const updateRunStatusSchema = z.object({
  endTime: z.string().datetime(),
  exitCode: z.number().int(),
  status: z.enum(["done", "error"]),
});

const governanceEventTypeSchema = z.enum([
  "gate_record",
  "manifest_update",
  "approval_required",
  "approval_recorded",
  "rollback_recorded",
]);

const manifestUpdateSchema = z.object({
  traceId: z.string().min(1).optional(),
  request: z.string().min(1).optional(),
  interpretedGoal: z.string().min(1).optional(),
  riskTier: riskTierSchema.optional(),
  governancePack: z.string().min(1).optional(),
  workers: z.array(z.string().min(1)).optional(),
  result: runManifestResultSchema.optional(),
  summary: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
}).strict();

const runEventSchema = z.object({
  runId: z.string().min(1),
  ts: z.number().finite(),
  type: z.enum([
    "user",
    "assistant",
    "tool_use",
    "tool_result",
    "error",
    "gate_record",
    "manifest_update",
    "approval_required",
    "approval_recorded",
    "rollback_recorded",
  ]),
  summary: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  agentName: z.string().min(1).optional(),
  agentDepth: z.number().int().optional(),
  parentAgent: z.string().min(1).optional(),
  agentKind: z.string().min(1).optional(),
  raw: z.unknown().optional(),
});

const duplicateFlowSchema = z.object({
  sourcePath: flowPathSchema,
  name: z.string().trim().min(1),
});

const runParamsSchema = z.object({
  id: z.string().min(1),
});

const flowQuerySchema = z.object({
  path: flowPathSchema,
});

const runEventRequestSchema = runEventSchema.omit({ runId: true });
const runEventBatchRequestSchema = z.object({
  events: z.array(runEventRequestSchema).min(1),
});

const saveFlowSchema = z.object({
  flowPath: flowPathSchema,
  flow: z.unknown(),
});

const staleThresholdMs = 10 * 60 * 1000;

type ManifestUpdate = z.infer<typeof manifestUpdateSchema>;
type GovernanceEventType = z.infer<typeof governanceEventTypeSchema>;

function parseGovernanceRaw(type: GovernanceEventType, raw: unknown): GateRecord | ManifestUpdate | ApprovalRecord | RollbackRecord {
  if (type === "gate_record") {
    return gateRecordSchema.parse(raw);
  }
  if (type === "manifest_update") {
    return manifestUpdateSchema.parse(raw);
  }
  if (type === "approval_required" || type === "approval_recorded") {
    return approvalRecordSchema.parse(raw);
  }
  return rollbackRecordSchema.parse(raw);
}

function toRunEvent(runId: string, payload: z.infer<typeof runEventRequestSchema>): PersistedRunEvent {
  const governanceType = governanceEventTypeSchema.safeParse(payload.type);
  const raw = governanceType.success ? parseGovernanceRaw(governanceType.data, payload.raw) : payload.raw;
  return {
    runId,
    ts: payload.ts,
    type: payload.type,
    summary: payload.summary,
    toolName: payload.toolName,
    agentName: payload.agentName,
    agentDepth: payload.agentDepth,
    parentAgent: payload.parentAgent,
    agentKind: payload.agentKind,
    raw,
  };
}

function resultFromRunStatus(status: RunStatus): RunManifestResult {
  if (status === "done" || status === "success") return "pass";
  if (status === "failed" || status === "error") return "fail";
  if (status === "aborted") return "aborted";
  if (status === "stale") return "blocked";
  return "running";
}

function isSideEffectTier(tier: RiskTier): boolean {
  return tier === "side_effect" || tier === "enterprise";
}

function isSideEffectBoundaryGate(gate: string): boolean {
  const normalized = gate.toLowerCase();
  return normalized.includes("side-effect") || normalized.includes("dispatch");
}

function hasSideEffectApproval(manifest: RunManifest): boolean {
  return (manifest.approvals ?? []).some((approval) =>
    approval.status === "approved"
      && (approval.gate === undefined || isSideEffectBoundaryGate(approval.gate) || approval.gate === "approval-record")
      && Boolean(approval.approvalText?.trim() || approval.evidence?.length),
  );
}

function hasRollbackEvidence(manifest: RunManifest): boolean {
  return (manifest.rollbacks ?? []).some((rollback) =>
    ["planned", "verified", "executed"].includes(rollback.status)
      && Boolean(rollback.rollbackPlan.trim())
      && (rollback.gate === undefined || isSideEffectBoundaryGate(rollback.gate) || rollback.gate === "rollback-record"),
  );
}

function buildRunManifestFromEvents(
  run: NonNullable<ReturnType<typeof getRun>>,
  events: PersistedRunEvent[],
): { manifest: RunManifest; hasGovernance: boolean } {
  const fallbackRequest = run.userPrompt?.trim() || "(request not recorded)";
  const manifest: RunManifest = {
    runId: run.runId,
    traceId: run.runId,
    request: fallbackRequest,
    interpretedGoal: fallbackRequest,
    riskTier: "quick",
    governancePack: "quick-direct",
    workers: run.agentResults.map((agent) => agent.agentName),
    gates: [],
    approvals: [],
    rollbacks: [],
    result: resultFromRunStatus(run.status),
    updatedAt: run.endedAt ?? run.startedAt ?? run.createdAt,
  };
  let hasGovernance = false;

  for (const event of events) {
    const parsedType = governanceEventTypeSchema.safeParse(event.type);
    if (!parsedType.success) continue;
    hasGovernance = true;

    if (parsedType.data === "manifest_update") {
      const update = manifestUpdateSchema.parse(event.raw);
      if (update.traceId !== undefined) manifest.traceId = update.traceId;
      if (update.request !== undefined) manifest.request = update.request;
      if (update.interpretedGoal !== undefined) manifest.interpretedGoal = update.interpretedGoal;
      if (update.riskTier !== undefined) manifest.riskTier = update.riskTier;
      if (update.governancePack !== undefined) manifest.governancePack = update.governancePack;
      if (update.workers !== undefined) manifest.workers = update.workers;
      if (update.result !== undefined) manifest.result = update.result;
      if (update.summary !== undefined) manifest.summary = update.summary;
      manifest.updatedAt = update.updatedAt ?? new Date(event.ts).toISOString();
      continue;
    }

    if (parsedType.data === "gate_record") {
      manifest.gates.push(gateRecordSchema.parse(event.raw));
      manifest.updatedAt = new Date(event.ts).toISOString();
      continue;
    }

    if (parsedType.data === "approval_required" || parsedType.data === "approval_recorded") {
      manifest.approvals = [...(manifest.approvals ?? []), approvalRecordSchema.parse(event.raw)];
      manifest.updatedAt = new Date(event.ts).toISOString();
      continue;
    }

    manifest.rollbacks = [...(manifest.rollbacks ?? []), rollbackRecordSchema.parse(event.raw)];
    manifest.updatedAt = new Date(event.ts).toISOString();
  }

  return { manifest, hasGovernance };
}

function blockedSideEffectGateEvent(
  run: NonNullable<ReturnType<typeof getRun>>,
  existingEvents: PersistedRunEvent[],
  event: PersistedRunEvent,
): { event: PersistedRunEvent; message: string } | undefined {
  if (event.type !== "gate_record") return undefined;
  const gate = gateRecordSchema.parse(event.raw);
  if (gate.status !== "pass" || !isSideEffectBoundaryGate(gate.gate)) return undefined;

  const { manifest } = buildRunManifestFromEvents(run, existingEvents);
  const missing: string[] = [];
  if (!hasSideEffectApproval(manifest)) missing.push("approved approval record");
  if (!hasRollbackEvidence(manifest)) missing.push("rollback record");
  if (missing.length === 0) return undefined;

  const tierLabel = isSideEffectTier(manifest.riskTier) ? `Tier ${manifest.riskTier}` : "Side-effect";
  const message = `${tierLabel} gate "${gate.gate}" cannot pass before ${missing.join(" and ")} exist.`;
  const blockedGate: GateRecord = {
    ...gate,
    status: "blocked",
    reason: message,
    blockers: [...new Set([...(gate.blockers ?? []), ...missing])],
    recordedAt: gate.recordedAt ?? new Date(event.ts).toISOString(),
  };
  return {
    message,
    event: {
      ...event,
      summary: `gate ${gate.gate}: blocked`,
      raw: blockedGate,
    },
  };
}

function ensureStaleRunsMarked(): void {
  markStaleRuns();
}

function getServerOriginFromRequest(request: { headers: { origin?: string | string[] } }): string {
  const originHeader = request.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (typeof origin === "string" && origin.trim()) {
    return origin;
  }
  return `http://localhost:${port}`;
}

function parseFlowPayload(input: unknown): { flow: z.infer<typeof flowSchema>; migrationNotes: LegacyMigrationNote[] } {
  const migrated = migrateLegacyFlowDefinitionInput(input);
  const parsedFlow = flowSchema.safeParse(migrated.value);
  if (!parsedFlow.success) {
    throw parsedFlow.error;
  }
  const validationErrors = validateFlow(parsedFlow.data);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("\n"));
  }
  return { flow: parsedFlow.data, migrationNotes: migrated.notes };
}

async function loadFlowForRun(flowPath: string): Promise<{ flow: z.infer<typeof flowSchema>; migrationNotes: LegacyMigrationNote[] }> {
  const absolutePath = path.resolve(workspaceRoot, flowPath);
  const raw = await readFile(absolutePath, "utf8");
  return parseFlowPayload(YAML.parse(raw));
}

export function buildServer() {
  ensureStaleRunsMarked();
  const app = Fastify({ logger: true });
  const runEventStreams = new Map<string, Set<(event: PersistedRunEvent) => void>>();

  const emitRunEvent = (event: PersistedRunEvent) => {
    appendRunEvent(event);
    for (const listener of runEventStreams.get(event.runId) ?? []) {
      listener(event);
    }
  };

  app.addHook("onSend", async (_request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "content-type");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  });

  app.options("/*", async (_request, reply) => reply.code(204).send());

  app.get("/health", async () => ({ ok: true }));

  app.get("/flows", async () => {
    const entries = await readdir(allowedFlowDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => `examples/${entry.name}`)
      .sort();
    return { flows: files };
  });

  app.get("/flows/get", async (request, reply) => {
    const parsed = flowQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const absolutePath = path.resolve(workspaceRoot, parsed.data.path);
    const raw = await readFile(absolutePath, "utf8");
    let loaded;
    try {
      loaded = parseFlowPayload(YAML.parse(raw));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: flattenValidationError(error) });
      }
      return reply.code(400).send({
        error: {
          formErrors: [error instanceof Error ? error.message : String(error)],
          fieldErrors: { flow: [error instanceof Error ? error.message : String(error)] },
        },
      });
    }

    logMigrationNotes(request.log, parsed.data.path, loaded.migrationNotes);
    return reply.code(200).send(withMigrationNotes({ flowPath: parsed.data.path, flow: loaded.flow }, loaded.migrationNotes));
  });

  app.put("/flows/save", async (request, reply) => {
    const parsed = saveFlowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    let loaded;
    try {
      loaded = parseFlowPayload(parsed.data.flow);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: flattenValidationError(error) });
      }
      return reply.code(400).send({
        error: {
          formErrors: [error instanceof Error ? error.message : String(error)],
          fieldErrors: { flow: [error instanceof Error ? error.message : String(error)] },
        },
      });
    }

    const absolutePath = path.resolve(workspaceRoot, parsed.data.flowPath);
    const tempPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.tmp`);
    const yaml = stringifyFlow(loaded.flow);

    await writeFile(tempPath, yaml, "utf8");
    await rename(tempPath, absolutePath);

    logMigrationNotes(request.log, parsed.data.flowPath, loaded.migrationNotes);
    return reply.code(200).send(withMigrationNotes({ flowPath: parsed.data.flowPath }, loaded.migrationNotes));
  });

  app.post("/flows/duplicate", async (request, reply) => {
    const parsed = duplicateFlowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const sourcePath = path.resolve(workspaceRoot, parsed.data.sourcePath);
    const raw = await readFile(sourcePath, "utf8");
    let sourceFlow;
    try {
      sourceFlow = parseFlowPayload(YAML.parse(raw));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: flattenValidationError(error) });
      }
      return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } });
    }

    const baseName = parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "flow-copy";
    let candidatePath = `examples/${baseName}.yaml`;
    let suffix = 2;

    while (true) {
      const candidateAbsolute = path.resolve(workspaceRoot, candidatePath);
      try {
        await readFile(candidateAbsolute, "utf8");
        candidatePath = `examples/${baseName}-${suffix}.yaml`;
        suffix += 1;
      } catch {
        break;
      }
    }

    const duplicatedFlow = {
      ...sourceFlow.flow,
      name: parsed.data.name,
    };
    const tempPath = path.join(allowedFlowDir, `.${path.basename(candidatePath)}.tmp`);
    const absolutePath = path.resolve(workspaceRoot, candidatePath);
    await writeFile(tempPath, stringifyFlow(duplicatedFlow), "utf8");
    await rename(tempPath, absolutePath);

    logMigrationNotes(request.log, parsed.data.sourcePath, sourceFlow.migrationNotes);
    return reply.code(201).send(withMigrationNotes({ flowPath: candidatePath, flow: duplicatedFlow }, sourceFlow.migrationNotes));
  });

  app.post("/flows/new", async (request, reply) => {
    const body = request.body as { name?: string } | null;
    const name = (body?.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "name is required" });

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `flow-${Date.now()}`;
    let candidatePath = `examples/${slug}.yaml`;
    let suffix = 2;
    while (true) {
      try {
        await readFile(path.resolve(workspaceRoot, candidatePath), "utf8");
        candidatePath = `examples/${slug}-${suffix}.yaml`;
        suffix += 1;
      } catch {
        break;
      }
    }

    const skeleton = {
      name,
      description: "TODO: describe this flow.\n",
      repo: ".",
      flowMd: "# Flow Common Policy\n- 범위 엄수. 인접 불가침. 가정 명시.\n",
      flowMdLibrary: {},
      orchestrator: {
        name: "leader",
        type: "codex" as const,
        runtime: {
          mode: "host" as const,
          profile: "codex-default",
          applyResources: "prompt-only" as const,
          delegationTransport: "mcp" as const,
        },
        model: "gpt-5.5",
        system: `You are the orchestrator for ${name}. Delegate work to your team.\n`,
        effort: "high" as const,
        delegation: [],
        agents: [],
      },
    };
    const tempPath = path.join(allowedFlowDir, `.${path.basename(candidatePath)}.tmp`);
    const absolutePath = path.resolve(workspaceRoot, candidatePath);
    await writeFile(tempPath, stringifyFlow(skeleton), "utf8");
    await rename(tempPath, absolutePath);
    return reply.code(201).send({ flowPath: candidatePath, flow: skeleton });
  });

  app.delete("/flows/:path", async (request, reply) => {
    const { path: flowPath } = request.params as { path: string };
    const fullPath = `examples/${flowPath}`;
    const parsed = flowPathSchema.safeParse(fullPath);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const absolutePath = path.resolve(workspaceRoot, parsed.data);
    try {
      await unlink(absolutePath);
      return reply.code(200).send({ ok: true });
    } catch {
      return reply.code(404).send({ error: { message: "flow not found" } });
    }
  });

  app.get("/runs", async (request, reply) => {
    ensureStaleRunsMarked();
    const parsed = runsListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const runs = listRuns(parsed.data.page, parsed.data.pageSize, {
      keyword: parsed.data.keyword,
      status: parsed.data.status,
    });
    return reply.code(200).send({
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      runs,
    });
  });

  app.get("/runs/:id", async (request, reply) => {
    const parsed = runParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const run = getRun(parsed.data.id);
    if (!run) {
      return reply.code(404).send({ error: { message: "run not found" } });
    }

    return reply.code(200).send(run);
  });

  app.post("/runs/:id/abort", async (request, reply) => {
    const parsed = runParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const aborted = abortLocalCliRun(parsed.data.id);
    if (!aborted) {
      return reply.code(404).send({ error: { message: "run not found" } });
    }

    return reply.code(202).send({ runId: parsed.data.id, aborted: true });
  });

  app.post("/runs", async (request, reply) => {
    const parsed = runRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    let loadedFlow;
    try {
      loadedFlow = await loadFlowForRun(parsed.data.flowPath);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: flattenValidationError(error) });
      }
      return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } });
    }

    const flow = loadedFlow.flow;
    logMigrationNotes(request.log, parsed.data.flowPath, loadedFlow.migrationNotes);
    const runId = randomUUID();
    const startTime = new Date().toISOString();
    const flowCwd = flow.repo ? (path.isAbsolute(flow.repo) ? flow.repo : path.resolve(workspaceRoot, flow.repo)) : workspaceRoot;
    createRunRecord({
      runId,
      flowName: flow.name,
      flowPath: parsed.data.flowPath,
      userPrompt: parsed.data.userPrompt,
      output: "",
      status: "running",
      source: "server",
      startedAt: startTime,
      cwd: flowCwd,
      agentType: flow.orchestrator.type,
      agentResults: [{ agentName: flow.orchestrator.name, output: "", startedAt: startTime }],
    });

    const serverOrigin = getServerOriginFromRequest(request);
    startLocalCliRun({
      runId,
      flowPath: parsed.data.flowPath,
      userPrompt: parsed.data.userPrompt,
      workspaceRoot,
      serverOrigin,
      onStdout: (chunk) => request.log.info({ runId, chunk }, "heddle cli stdout"),
      onStderr: (chunk) => request.log.warn({ runId, chunk }, "heddle cli stderr"),
      onExit: (exitCode) => {
        updateRunRecord(runId, {
          status: exitCode === 0 ? "done" : "error",
          exitCode,
          endedAt: new Date().toISOString(),
        });
      },
    });

    return reply.code(202).send(withMigrationNotes({
      runId,
      flowName: flow.name,
      status: "running",
      source: "server",
    }, loadedFlow.migrationNotes));
  });

  app.post("/runs/register", async (request, reply) => {
    const registerMigrationNotes = legacyAgentTypeNotes((request.body as { agentType?: unknown } | null)?.agentType);
    const parsed = registerRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }
    logMigrationNotes(request.log, parsed.data.runId, registerMigrationNotes);

    if (getRun(parsed.data.runId)) {
      return reply.code(200).send(withMigrationNotes({ runId: parsed.data.runId }, registerMigrationNotes));
    }
    createRunRecord({
      runId: parsed.data.runId,
      flowName: parsed.data.flowName,
      flowPath: parsed.data.flowPath,
      userPrompt: parsed.data.userPrompt ?? "",
      output: "",
      status: "running",
      source: parsed.data.source,
      startedAt: parsed.data.startTime,
      cwd: parsed.data.cwd ?? "",
      agentType: parsed.data.agentType,
      agentResults: [
        {
          agentName: parsed.data.agentType,
          output: "",
          startedAt: parsed.data.startTime,
        },
      ],
    });
    return reply.code(201).send(withMigrationNotes({ runId: parsed.data.runId }, registerMigrationNotes));
  });

  app.post("/runs/:id/events", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: flattenValidationError(params.error) });
    }

    const parsed = runEventBatchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const run = getRun(params.data.id);
    if (!run) {
      return reply.code(404).send({ error: { message: "run not found" } });
    }

    const stagedEvents = listRunEvents(params.data.id);
    const acceptedEvents: PersistedRunEvent[] = [];
    let blockedMessage: string | undefined;
    try {
      for (const eventPayload of parsed.data.events) {
        const event = toRunEvent(params.data.id, eventPayload);
        const blocked = blockedSideEffectGateEvent(run, stagedEvents, event);
        if (blocked) {
          stagedEvents.push(blocked.event);
          acceptedEvents.push(blocked.event);
          blockedMessage = blocked.message;
          break;
        }
        stagedEvents.push(event);
        acceptedEvents.push(event);
      }
    } catch (error) {
      return reply.code(409).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }

    for (const event of acceptedEvents) {
      emitRunEvent(event);
    }
    if (blockedMessage) {
      return reply.code(409).send({
        error: {
          message: blockedMessage,
        },
      });
    }
    return reply.code(201).send({ runId: params.data.id, count: parsed.data.events.length });
  });

  app.get("/runs/:id/manifest", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: flattenValidationError(params.error) });
    }

    const run = getRun(params.data.id);
    if (!run) {
      return reply.code(404).send({ error: { message: "run not found" } });
    }

    const manifestState = buildRunManifestFromEvents(run, listRunEvents(params.data.id));
    return reply.code(200).send({
      runId: params.data.id,
      hasGovernance: manifestState.hasGovernance,
      manifest: manifestState.manifest,
    });
  });

  app.get("/runs/:id/events", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: flattenValidationError(params.error) });
    }

    const run = getRun(params.data.id);
    if (!run) {
      return reply.code(404).send({ error: { message: "run not found" } });
    }

    return reply.code(200).send({ runId: params.data.id, events: listRunEvents(params.data.id) });
  });

  app.get("/runs/:id/stream", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: flattenValidationError(params.error) });
    }

    const run = getRun(params.data.id);
    if (!run) {
      return reply.code(404).send({ error: { message: "run not found" } });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const write = (event: PersistedRunEvent) => {
      reply.raw.write("event: run_event\n");
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const listener = (event: PersistedRunEvent) => {
      write(event);
    };

    const listeners = runEventStreams.get(params.data.id) ?? new Set();
    listeners.add(listener);
    runEventStreams.set(params.data.id, listeners);

    const heartbeat = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, Math.min(staleThresholdMs, 15_000));

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      const currentListeners = runEventStreams.get(params.data.id);
      currentListeners?.delete(listener);
      if (currentListeners && currentListeners.size === 0) {
        runEventStreams.delete(params.data.id);
      }
    });

    return reply;
  });

  app.patch("/runs/:id/status", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: flattenValidationError(params.error) });
    }

    const parsed = updateRunStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const updated = updateRunRecord(params.data.id, {
      status: parsed.data.status,
      exitCode: parsed.data.exitCode,
      endedAt: parsed.data.endTime,
    });
    if (!updated) {
      return reply.code(404).send({ error: { message: "run not found" } });
    }

    return reply.code(200).send({ runId: params.data.id });
  });

// ── Resource discovery ──────────────────────────────────────────

  app.get("/mcps", async () => {
    const names = new Set<string>();
    try {
      const raw = await readFile(path.join(workspaceRoot, ".mcp.json"), "utf8");
      const cfg = JSON.parse(raw);
      const servers = cfg.mcpServers;
      if (servers && typeof servers === "object") {
        for (const k of Object.keys(servers)) names.add(k);
      }
    } catch { /* skip missing file */ }

    try {
      const raw = await readFile(path.join(homedir(), ".codex", "config.toml"), "utf8");
      const mcpSectionRegex = /^\[mcp_servers\.([^\]]+)\]/gm;
      let match;
      while ((match = mcpSectionRegex.exec(raw)) !== null) {
        names.add(match[1].trim());
      }
    } catch { /* skip missing file */ }

    return { mcps: [...names].sort() };
  });

  app.get("/discover", async () => {
    interface DiscoveredResource {
      type: "mcp" | "hook" | "skill";
      name: string;
      source: string;
      platform: "codex";
      event?: string;
      command?: string;
      prompt?: string;
    }
    const resources: DiscoveredResource[] = [];
    const providers = (await discoverProviderProfiles()).filter((provider) => provider.kind === "codex");

    const workspaceMcpPath = path.join(workspaceRoot, ".mcp.json");
    try {
      const raw = await readFile(workspaceMcpPath, "utf8");
      const cfg = JSON.parse(raw);
      if (cfg.mcpServers && typeof cfg.mcpServers === "object") {
        for (const name of Object.keys(cfg.mcpServers)) {
          resources.push({ type: "mcp", name, source: workspaceMcpPath, platform: "codex" });
        }
      }
    } catch { /* skip */ }

    // MCPs — Codex side (~/.codex/config.toml's [mcp_servers.NAME] sections)
    const codexConfigPath = path.join(homedir(), ".codex", "config.toml");
    try {
      const raw = await readFile(codexConfigPath, "utf8");
      const mcpSectionRegex = /^\[mcp_servers\.([^\]]+)\]/gm;
      let match;
      const seen = new Set<string>();
      while ((match = mcpSectionRegex.exec(raw)) !== null) {
        const name = match[1].trim();
        if (!seen.has(name)) {
          seen.add(name);
          resources.push({ type: "mcp", name, source: codexConfigPath, platform: "codex" });
        }
      }
    } catch { /* skip */ }

    // Heddle project skills (workspace/skills/*.yaml)
    const heddleSkillsDir = path.join(workspaceRoot, "skills");
    try {
      const entries = await readdir(heddleSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
        const name = entry.name.replace(/\.yaml$/, "");
        const raw = await readFile(path.join(heddleSkillsDir, entry.name), "utf8").catch(() => "");
        resources.push({ type: "skill", name, source: heddleSkillsDir, platform: "codex", prompt: raw.slice(0, 300) });
      }
    } catch { /* skip */ }

    // Heddle project hooks (workspace/hooks/*.yaml)
    const heddleHooksDir = path.join(workspaceRoot, "hooks");
    try {
      const entries = await readdir(heddleHooksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
        const name = entry.name.replace(/\.yaml$/, "");
        const raw = await readFile(path.join(heddleHooksDir, entry.name), "utf8").catch(() => "");
        const eventMatch = raw.match(/^event:\s*(\S+)/m);
        const commandMatch = raw.match(/^command:\s*(.+)$/m);
        const event = eventMatch?.[1];
        const command = commandMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "");
        resources.push({ type: "hook", name, source: heddleHooksDir, platform: "codex", event, command });
      }
    } catch { /* skip */ }

    return { providers, resources };
  });

  // ── Role endpoints ──────────────────────────────────────────────

  app.get("/roles", async () => {
    await mkdir(rolesDir, { recursive: true });
    const entries = await readdir(rolesDir, { withFileTypes: true });
    const roles = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const raw = await readFile(path.join(rolesDir, entry.name), "utf8");
      const migrated = migrateLegacyRoleDefinitionInput(YAML.parse(raw));
      const parsed = roleDefinitionSchema.safeParse(migrated.value);
      if (parsed.success) roles.push(parsed.data);
    }
    return { roles };
  });

  app.get("/roles/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const filePath = path.join(rolesDir, `${name}.yaml`);
    try {
      const raw = await readFile(filePath, "utf8");
      const migrated = migrateLegacyRoleDefinitionInput(YAML.parse(raw));
      const parsed = roleDefinitionSchema.safeParse(migrated.value);
      if (!parsed.success) {
        return reply.code(400).send({ error: flattenValidationError(parsed.error) });
      }
      logMigrationNotes(request.log, name, migrated.notes);
      return withMigrationNotes({ role: parsed.data }, migrated.notes);
    } catch {
      return reply.code(404).send({ error: { message: "role not found" } });
    }
  });

  app.put("/roles/save", async (request, reply) => {
    const migrated = migrateLegacyRoleDefinitionInput(request.body);
    const parsed = roleDefinitionSchema.safeParse(migrated.value);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }
    logMigrationNotes(request.log, parsed.data.name, migrated.notes);
    await mkdir(rolesDir, { recursive: true });
    const fileName = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const filePath = path.join(rolesDir, `${fileName}.yaml`);
    await writeFile(filePath, YAML.stringify(parsed.data), "utf8");
    return reply.code(200).send(withMigrationNotes({ role: parsed.data }, migrated.notes));
  });

  app.delete("/roles/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const filePath = path.join(rolesDir, `${name}.yaml`);
    try {
      await unlink(filePath);
      return reply.code(200).send({ ok: true });
    } catch {
      return reply.code(404).send({ error: { message: "role not found" } });
    }
  });

  // ── Hook endpoints ─────────────────────────────────────────────

  app.get("/hooks", async () => {
    await mkdir(hooksDir, { recursive: true });
    const entries = await readdir(hooksDir, { withFileTypes: true });
    const hooks = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const raw = await readFile(path.join(hooksDir, entry.name), "utf8");
      const parsed = hookDefinitionSchema.safeParse(YAML.parse(raw));
      if (parsed.success) hooks.push(parsed.data);
    }
    return { hooks };
  });

  app.put("/hooks/save", async (request, reply) => {
    const parsed = hookDefinitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }
    await mkdir(hooksDir, { recursive: true });
    const fileName = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const filePath = path.join(hooksDir, `${fileName}.yaml`);
    await writeFile(filePath, YAML.stringify(parsed.data), "utf8");
    return reply.code(200).send({ hook: parsed.data });
  });

  app.delete("/hooks/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const filePath = path.join(hooksDir, `${name}.yaml`);
    try {
      await unlink(filePath);
      return reply.code(200).send({ ok: true });
    } catch {
      return reply.code(404).send({ error: { message: "hook not found" } });
    }
  });

  // ── Skill endpoints ───────────────────────────────────────────

  app.get("/skills", async () => {
    await mkdir(skillsDir, { recursive: true });
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const raw = await readFile(path.join(skillsDir, entry.name), "utf8");
      const parsed = skillDefinitionSchema.safeParse(YAML.parse(raw));
      if (parsed.success) skills.push(parsed.data);
    }
    return { skills };
  });

  app.put("/skills/save", async (request, reply) => {
    const parsed = skillDefinitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }
    await mkdir(skillsDir, { recursive: true });
    const fileName = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const filePath = path.join(skillsDir, `${fileName}.yaml`);
    await writeFile(filePath, YAML.stringify(parsed.data), "utf8");
    return reply.code(200).send({ skill: parsed.data });
  });

  app.delete("/skills/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const filePath = path.join(skillsDir, `${name}.yaml`);
    try {
      await unlink(filePath);
      return reply.code(200).send({ ok: true });
    } catch {
      return reply.code(404).send({ error: { message: "skill not found" } });
    }
  });

  return app;
}

const port = Number(process.env.PORT ?? 8787);

if (process.env.HEDDLE_SERVER_AUTOSTART !== "0") {
  const server = buildServer();

  server.listen({ port, host: "0.0.0.0" }).catch((error) => {
    server.log.error(error);
    process.exit(1);
  });
}
