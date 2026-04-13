import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import YAML from "yaml";
import { flowSchema, roleDefinitionSchema, hookDefinitionSchema, skillDefinitionSchema } from "@loom/core";
import { validateFlow } from "@loom/nodes";
import { abortRun, runFlow, streamRunFlow } from "./runner.js";
import { stringifyFlow } from "./flow-writer.js";
import { createRunRecord, getRun, listRuns, updateRunRecord } from "./trace-store.js";

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
  status: z.enum(["success", "failed", "aborted", "running", "done", "error"]).optional(),
});

const registerRunSchema = z.object({
  runId: z.string().min(1),
  flowPath: z.string().min(1),
  flowName: z.string().min(1),
  agentType: z.enum(["claude-code", "codex"]),
  startTime: z.string().datetime(),
  source: z.literal("cli"),
});

const updateRunStatusSchema = z.object({
  endTime: z.string().datetime(),
  exitCode: z.number().int(),
  status: z.enum(["done", "error"]),
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

const saveFlowSchema = z.object({
  flowPath: flowPathSchema,
  flow: flowSchema,
});

export function buildServer() {
  const app = Fastify({ logger: true });

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

    const aborted = abortRun(parsed.data.id);
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

    const result = await runFlow(parsed.data.flowPath, parsed.data.userPrompt);
    return reply.code(200).send(result);
  });

  app.post("/runs/register", async (request, reply) => {
    const parsed = registerRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    createRunRecord({
      runId: parsed.data.runId,
      flowName: parsed.data.flowName,
      flowPath: parsed.data.flowPath,
      userPrompt: "",
      output: "",
      status: "running",
      source: parsed.data.source,
      startedAt: parsed.data.startTime,
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

  app.post("/runs/stream", async (request, reply) => {
    const parsed = runRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const write = (eventType: string, data: unknown) => {
      reply.raw.write(`event: ${eventType}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const event of streamRunFlow(parsed.data.flowPath, parsed.data.userPrompt)) {
        const { type, ...payload } = event;
        write(type, payload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write("run_error", { error: message });
    } finally {
      reply.raw.end();
    }

    return reply;
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

    // ── Claude resources ────────────────────────────────────────

    // MCPs
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

    // ── Codex resources ─────────────────────────────────────────

    // Codex skills — ~/.codex/skills/*.toml
    const codexSkillsDir = path.join(homedir(), ".codex", "skills");
    try {
      const entries = await readdir(codexSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = entry.name.replace(/\.(toml|md|yaml)$/, "");
        resources.push({ type: "skill", name, source: codexSkillsDir, platform: "codex" });
      }
    } catch { /* skip */ }

    // Codex agents — ~/.codex/agents/*.toml
    const codexAgentsDir = path.join(homedir(), ".codex", "agents");
    try {
      const entries = await readdir(codexAgentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = entry.name.replace(/\.(toml|md|yaml)$/, "");
        resources.push({ type: "skill", name: `agent:${name}`, source: codexAgentsDir, platform: "codex" });
      }
    } catch { /* skip */ }

    return { resources };
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
