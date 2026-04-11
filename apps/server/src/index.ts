import Fastify from "fastify";
import { z } from "zod";
import { runFlow } from "./runner.js";

const runRequestSchema = z.object({
  flowPath: z.string().min(1),
  inputs: z.record(z.unknown()).default({}),
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
