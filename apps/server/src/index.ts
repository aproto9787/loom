import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import YAML from "yaml";
import { flowSchema } from "@loom/core";
import { runFlow, streamRunFlow } from "./runner.js";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const allowedFlowDir = path.join(workspaceRoot, "examples");

function isAllowedFlowPath(flowPath: string): boolean {
  if (path.isAbsolute(flowPath)) {
    return false;
  }

  const absolutePath = path.resolve(workspaceRoot, flowPath);
  return absolutePath.startsWith(`${allowedFlowDir}${path.sep}`);
}

const runRequestSchema = z.object({
  flowPath: z.string().min(1).refine(isAllowedFlowPath, {
    message: "flowPath must stay within examples/",
  }),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

export function buildServer() {
  const app = Fastify({ logger: true });

  // CORS for studio dev server (http://localhost:5173 → http://localhost:8787)
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "content-type");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
    path: z.string().min(1).refine(isAllowedFlowPath, {
      message: "path must stay within examples/",
    }),
  });

  app.get("/flows/get", async (request, reply) => {
    const parsed = flowQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const absolutePath = path.resolve(workspaceRoot, parsed.data.path);
    const raw = await readFile(absolutePath, "utf8");
    const parsedFlow = flowSchema.safeParse(YAML.parse(raw));
    if (!parsedFlow.success) {
      return reply.code(400).send({ error: parsedFlow.error.flatten() });
    }

    return reply.code(200).send({ flowPath: parsed.data.path, flow: parsedFlow.data });
  });

  app.post("/runs", async (request, reply) => {
    const parsed = runRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const result = await runFlow(parsed.data.flowPath, parsed.data.inputs);
    return reply.code(200).send(result);
  });

  app.post("/runs/stream", async (request, reply) => {
    const parsed = runRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
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
