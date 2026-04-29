import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import YAML from "yaml";
import { flowSchema, roleDefinitionSchema, hookDefinitionSchema, skillDefinitionSchema } from "@aproto9787/loom-core";
import { discoverProviderProfiles } from "@aproto9787/loom-runtime";
import { getOracleAdvisorStatus, oracleAdvisorPlugin, runOracleAdvisor } from "@aproto9787/loom-plugin-oracle";
import type { PersistedRunEvent } from "./trace-store.js";
import { validateFlow } from "@aproto9787/loom-core";
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
  agentType: z.enum(["claude-code", "codex"]),
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

const runEventSchema = z.object({
  runId: z.string().min(1),
  ts: z.number().finite(),
  type: z.enum(["user", "assistant", "tool_use", "tool_result", "error"]),
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
  flow: flowSchema,
});

const oracleAdvisorRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  files: z.array(z.string().trim().min(1)).default([]),
  args: z.array(z.string()).default([]),
  timeoutSeconds: z.number().min(1).default(1800),
  useNpxFallback: z.boolean().default(true),
});

const staleThresholdMs = 10 * 60 * 1000;

function toRunEvent(runId: string, payload: z.infer<typeof runEventRequestSchema>): PersistedRunEvent {
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
    raw: payload.raw,
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

async function loadFlowForRun(flowPath: string): Promise<z.infer<typeof flowSchema>> {
  const absolutePath = path.resolve(workspaceRoot, flowPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsedFlow = flowSchema.safeParse(YAML.parse(raw));
  if (!parsedFlow.success) {
    throw parsedFlow.error;
  }
  const validationErrors = validateFlow(parsedFlow.data);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("\n"));
  }
  return parsedFlow.data;
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
    const parsedFlow = flowSchema.safeParse(YAML.parse(raw));
    if (!parsedFlow.success) {
      return reply.code(400).send({ error: flattenValidationError(parsedFlow.error) });
    }

    const validationErrors = validateFlow(parsedFlow.data);
    if (validationErrors.length > 0) {
      return reply.code(400).send({
        error: {
          formErrors: validationErrors,
          fieldErrors: { flow: validationErrors },
        },
      });
    }

    return reply.code(200).send({ flowPath: parsed.data.path, flow: parsedFlow.data });
  });

  app.put("/flows/save", async (request, reply) => {
    const parsed = saveFlowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const validationErrors = validateFlow(parsed.data.flow);
    if (validationErrors.length > 0) {
      return reply.code(400).send({
        error: {
          formErrors: validationErrors,
          fieldErrors: { flow: validationErrors },
        },
      });
    }

    const absolutePath = path.resolve(workspaceRoot, parsed.data.flowPath);
    const tempPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.tmp`);
    const yaml = stringifyFlow(parsed.data.flow);

    await writeFile(tempPath, yaml, "utf8");
    await rename(tempPath, absolutePath);

    return reply.code(200).send({ flowPath: parsed.data.flowPath });
  });

  app.post("/flows/duplicate", async (request, reply) => {
    const parsed = duplicateFlowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const sourcePath = path.resolve(workspaceRoot, parsed.data.sourcePath);
    const raw = await readFile(sourcePath, "utf8");
    const sourceFlow = flowSchema.safeParse(YAML.parse(raw));
    if (!sourceFlow.success) {
      return reply.code(400).send({ error: flattenValidationError(sourceFlow.error) });
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
      ...sourceFlow.data,
      name: parsed.data.name,
    };
    const tempPath = path.join(allowedFlowDir, `.${path.basename(candidatePath)}.tmp`);
    const absolutePath = path.resolve(workspaceRoot, candidatePath);
    await writeFile(tempPath, stringifyFlow(duplicatedFlow), "utf8");
    await rename(tempPath, absolutePath);

    return reply.code(201).send({ flowPath: candidatePath, flow: duplicatedFlow });
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
        type: "claude-code" as const,
        runtime: {
          mode: "host" as const,
          profile: "claude-default",
          applyResources: "prompt-only" as const,
          delegationTransport: "mcp" as const,
        },
        model: "claude-opus-4-7",
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

    let flow;
    try {
      flow = await loadFlowForRun(parsed.data.flowPath);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: flattenValidationError(error) });
      }
      return reply.code(400).send({ error: { message: error instanceof Error ? error.message : String(error) } });
    }

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
      onStdout: (chunk) => request.log.info({ runId, chunk }, "loom cli stdout"),
      onStderr: (chunk) => request.log.warn({ runId, chunk }, "loom cli stderr"),
      onExit: (exitCode) => {
        updateRunRecord(runId, {
          status: exitCode === 0 ? "done" : "error",
          exitCode,
          endedAt: new Date().toISOString(),
        });
      },
    });

    return reply.code(202).send({
      runId,
      flowName: flow.name,
      status: "running",
      source: "server",
    });
  });

  app.post("/runs/register", async (request, reply) => {
    const parsed = registerRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    if (getRun(parsed.data.runId)) {
      return reply.code(200).send({ runId: parsed.data.runId });
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
    return reply.code(201).send({ runId: parsed.data.runId });
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

    for (const event of parsed.data.events) {
      emitRunEvent(toRunEvent(params.data.id, event));
    }
    return reply.code(201).send({ runId: params.data.id, count: parsed.data.events.length });
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

  app.get(`${oracleAdvisorPlugin.routeBasePath}/status`, async () => {
    return await getOracleAdvisorStatus();
  });

  app.post(`${oracleAdvisorPlugin.routeBasePath}/run`, async (request, reply) => {
    const parsed = oracleAdvisorRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const runId = randomUUID();
    const startTime = new Date().toISOString();
    createRunRecord({
      runId,
      flowName: `${oracleAdvisorPlugin.displayName} Plugin`,
      flowPath: oracleAdvisorPlugin.runFlowPath,
      userPrompt: parsed.data.prompt,
      output: "",
      status: "running",
      source: "server",
      startedAt: startTime,
      cwd: workspaceRoot,
      agentResults: [],
    });
    emitRunEvent({
      runId,
      ts: Date.now(),
      type: "tool_use",
      summary: "Oracle advisor requested",
      toolName: oracleAdvisorPlugin.mcpToolName,
      agentName: "studio",
      agentDepth: 0,
      agentKind: oracleAdvisorPlugin.kind,
      raw: {
        pluginId: oracleAdvisorPlugin.id,
        prompt: parsed.data.prompt,
        files: parsed.data.files,
        args: parsed.data.args,
        useNpxFallback: parsed.data.useNpxFallback,
      },
    });

    const result = await runOracleAdvisor({
      ...parsed.data,
      cwd: workspaceRoot,
    });
    emitRunEvent({
      runId,
      ts: Date.now(),
      type: result.status === "error" ? "error" : "tool_result",
      summary: result.status === "unavailable" ? "Oracle advisor unavailable" : `Oracle advisor ${result.status}`,
      toolName: oracleAdvisorPlugin.mcpToolName,
      agentName: "studio",
      agentDepth: 0,
      agentKind: oracleAdvisorPlugin.kind,
      raw: result,
    });
    updateRunRecord(runId, {
      status: result.status === "done" ? "done" : "error",
      output: result.stdout || result.stderr || result.installHint || "",
      exitCode: result.exitCode ?? (result.status === "done" ? 0 : 1),
      endedAt: new Date().toISOString(),
      cwd: workspaceRoot,
    });

    return reply.code(200).send({ runId, result });
  });

// ── Resource discovery ──────────────────────────────────────────

  app.get("/mcps", async () => {
    const sources = [
      path.join(homedir(), ".claude.json"),
      path.join(workspaceRoot, ".mcp.json"),
    ];
    const names = new Set<string>();
    for (const src of sources) {
      try {
        const raw = await readFile(src, "utf8");
        const cfg = JSON.parse(raw);
        const servers = cfg.mcpServers;
        if (servers && typeof servers === "object") {
          for (const k of Object.keys(servers)) names.add(k);
        }
      } catch { /* skip missing files */ }
    }
    return { mcps: [...names].sort() };
  });

  app.get("/discover", async () => {
    interface DiscoveredResource {
      type: "mcp" | "hook" | "skill";
      name: string;
      source: string;
      platform: "claude" | "codex";
      event?: string;
      command?: string;
      prompt?: string;
    }
    const resources: DiscoveredResource[] = [];
    const providers = await discoverProviderProfiles();

    // ── Claude resources ────────────────────────────────────────

    // MCPs — Claude side
    const mcpSources = [
      path.join(homedir(), ".claude.json"),
      path.join(workspaceRoot, ".mcp.json"),
    ];
    for (const src of mcpSources) {
      try {
        const raw = await readFile(src, "utf8");
        const cfg = JSON.parse(raw);
        if (cfg.mcpServers && typeof cfg.mcpServers === "object") {
          for (const name of Object.keys(cfg.mcpServers)) {
            resources.push({ type: "mcp", name, source: src, platform: "claude" });
          }
        }
      } catch { /* skip */ }
    }

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

    // Hooks
    const hookSources = [
      path.join(homedir(), ".claude", "settings.json"),
      path.join(workspaceRoot, ".claude", "settings.json"),
    ];
    for (const src of hookSources) {
      try {
        const raw = await readFile(src, "utf8");
        const cfg = JSON.parse(raw);
        if (cfg.hooks && typeof cfg.hooks === "object") {
          for (const [event, rules] of Object.entries(cfg.hooks)) {
            if (!Array.isArray(rules)) continue;
            for (const rule of rules as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>) {
              const cmds = (rule.hooks ?? []).map((h) => h.command).filter(Boolean);
              if (cmds.length > 0) {
                const label = rule.matcher ? `${event}:${rule.matcher}` : event;
                resources.push({ type: "hook", name: label, source: src, platform: "claude", event, command: cmds.join(" && ") });
              }
            }
          }
        }
      } catch { /* skip */ }
    }

    // Claude skills — ~/.claude/skills/*/SKILL.md
    const claudeSkillsDir = path.join(homedir(), ".claude", "skills");
    try {
      const skillEntries = await readdir(claudeSkillsDir, { withFileTypes: true });
      for (const entry of skillEntries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(claudeSkillsDir, entry.name, "SKILL.md");
        const prompt = await readFile(skillFile, "utf8").catch(() => "");
        if (prompt) {
          resources.push({ type: "skill", name: entry.name, source: claudeSkillsDir, platform: "claude", prompt: prompt.slice(0, 300) });
        }
      }
    } catch { /* skip */ }

    // Project-level claude skills
    const projSkillsDir = path.join(workspaceRoot, ".claude", "skills");
    try {
      const skillEntries = await readdir(projSkillsDir, { withFileTypes: true });
      for (const entry of skillEntries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(projSkillsDir, entry.name, "SKILL.md");
        const prompt = await readFile(skillFile, "utf8").catch(() => "");
        if (prompt) {
          resources.push({ type: "skill", name: entry.name, source: projSkillsDir, platform: "claude", prompt: prompt.slice(0, 300) });
        }
      }
    } catch { /* skip */ }

    // Loom project skills (workspace/skills/*.yaml) — platform-neutral, surface on both
    const loomSkillsDir = path.join(workspaceRoot, "skills");
    try {
      const entries = await readdir(loomSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
        const name = entry.name.replace(/\.yaml$/, "");
        const raw = await readFile(path.join(loomSkillsDir, entry.name), "utf8").catch(() => "");
        resources.push({ type: "skill", name, source: loomSkillsDir, platform: "claude", prompt: raw.slice(0, 300) });
        resources.push({ type: "skill", name, source: loomSkillsDir, platform: "codex", prompt: raw.slice(0, 300) });
      }
    } catch { /* skip */ }

    // Loom project hooks (workspace/hooks/*.yaml) — platform-neutral
    const loomHooksDir = path.join(workspaceRoot, "hooks");
    try {
      const entries = await readdir(loomHooksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
        const name = entry.name.replace(/\.yaml$/, "");
        const raw = await readFile(path.join(loomHooksDir, entry.name), "utf8").catch(() => "");
        const eventMatch = raw.match(/^event:\s*(\S+)/m);
        const commandMatch = raw.match(/^command:\s*(.+)$/m);
        const event = eventMatch?.[1];
        const command = commandMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "");
        resources.push({ type: "hook", name, source: loomHooksDir, platform: "claude", event, command });
        resources.push({ type: "hook", name, source: loomHooksDir, platform: "codex", event, command });
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
      const parsed = roleDefinitionSchema.safeParse(YAML.parse(raw));
      if (parsed.success) roles.push(parsed.data);
    }
    return { roles };
  });

  app.get("/roles/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const filePath = path.join(rolesDir, `${name}.yaml`);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = roleDefinitionSchema.safeParse(YAML.parse(raw));
      if (!parsed.success) {
        return reply.code(400).send({ error: flattenValidationError(parsed.error) });
      }
      return { role: parsed.data };
    } catch {
      return reply.code(404).send({ error: { message: "role not found" } });
    }
  });

  app.put("/roles/save", async (request, reply) => {
    const parsed = roleDefinitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }
    await mkdir(rolesDir, { recursive: true });
    const fileName = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const filePath = path.join(rolesDir, `${fileName}.yaml`);
    await writeFile(filePath, YAML.stringify(parsed.data), "utf8");
    return reply.code(200).send({ role: parsed.data });
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

if (process.env.LOOM_SERVER_AUTOSTART !== "0") {
  const server = buildServer();

  server.listen({ port, host: "0.0.0.0" }).catch((error) => {
    server.log.error(error);
    process.exit(1);
  });
}
