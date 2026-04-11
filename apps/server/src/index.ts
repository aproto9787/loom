import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { runFlow } from "./runner.js";

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

  app.get("/health", async () => ({ ok: true }));

  app.post("/runs", async (request, reply) => {
    const parsed = runRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const result = await runFlow(parsed.data.flowPath, parsed.data.inputs);
    return reply.code(200).send(result);
  });

  return app;
}

const port = Number(process.env.PORT ?? 8787);
const server = buildServer();

server.listen({ port, host: "0.0.0.0" }).catch((error) => {
  server.log.error(error);
  process.exit(1);
});
