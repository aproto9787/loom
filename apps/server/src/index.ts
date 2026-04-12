import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import YAML from "yaml";
import { flowSchema } from "@loom/core";
import { runFlow, streamRunFlow } from "./runner.js";
import { stringifyFlow } from "./flow-writer.js";
import { getRun, listRuns } from "./trace-store.js";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const allowedFlowDir = path.join(workspaceRoot, "examples");

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
  flowPath: z.string().min(1).refine(isAllowedFlowPath, {
    message: "flowPath must stay within examples/",
  }),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const runsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const runParamsSchema = z.object({
  id: z.string().min(1),
});

export function buildServer() {
  const app = Fastify({ logger: true });

  // CORS for studio dev server (http://localhost:5173 → http://localhost:8787)
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "content-type");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
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

  const flowQuerySchema = z.object({
    path: flowPathSchema,
  });

  const saveFlowSchema = z.object({
    flowPath: flowPathSchema,
    flow: flowSchema,
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

    return reply.code(200).send({ flowPath: parsed.data.path, flow: parsedFlow.data });
  });

  app.put("/flows/save", async (request, reply) => {
    const parsed = saveFlowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const absolutePath = path.resolve(workspaceRoot, parsed.data.flowPath);
    const tempPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.tmp`);
    const yaml = stringifyFlow(parsed.data.flow);

    await writeFile(tempPath, yaml, "utf8");
    await rename(tempPath, absolutePath);

    return reply.code(200).send({ flowPath: parsed.data.flowPath });
  });

  app.get("/runs", async (request, reply) => {
    const parsed = runsListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const runs = listRuns(parsed.data.page, parsed.data.pageSize);
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

  app.post("/runs", async (request, reply) => {
    const parsed = runRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: flattenValidationError(parsed.error) });
    }

    const result = await runFlow(parsed.data.flowPath, parsed.data.inputs);
    return reply.code(200).send(result);
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

    const write = (kind: string, data: unknown) => {
      reply.raw.write(`event: ${kind}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const event of streamRunFlow(parsed.data.flowPath, parsed.data.inputs)) {
        const { kind, ...payload } = event;
        write(kind, payload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write("run_error", { message });
    } finally {
      reply.raw.end();
    }

    return reply;
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
