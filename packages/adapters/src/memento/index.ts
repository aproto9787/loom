import path from "node:path";
import type { InvokeContext, InvokeEvent, RuntimeAdapter } from "@loom/core";
import { MCPStdioClient, type McpClientOptions, type McpTool } from "../mcp/client.js";

export const mementoAdapterId = "memento";

type MementoOperation = "remember" | "recall" | "forget";

interface MementoHandle {
  readonly tools: McpTool[];
  call(operation: MementoOperation, args: Record<string, unknown>): Promise<unknown>;
}

function getOperation(ctx: InvokeContext): MementoOperation {
  const operation = ctx.node.config.operation;
  if (operation === "remember" || operation === "recall" || operation === "forget") {
    return operation;
  }
  throw new Error("memory.memento requires config.operation to be one of remember|recall|forget");
}

function getClientOptions(ctx: InvokeContext): McpClientOptions {
  const command = typeof ctx.node.config.command === "string" ? ctx.node.config.command : undefined;
  if (!command) {
    throw new Error("memory.memento requires config.command");
  }

  const args = Array.isArray(ctx.node.config.args)
    ? ctx.node.config.args.filter((value): value is string => typeof value === "string")
    : [];

  const env: Record<string, string> = {};
  if (ctx.node.config.env && typeof ctx.node.config.env === "object") {
    for (const [key, value] of Object.entries(ctx.node.config.env as Record<string, unknown>)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
  }

  const cwd = typeof ctx.node.config.cwd === "string"
    ? (path.isAbsolute(ctx.node.config.cwd) ? ctx.node.config.cwd : path.resolve(process.cwd(), ctx.node.config.cwd))
    : process.cwd();

  return { command, args, env, cwd };
}

function getToolArgs(ctx: InvokeContext): Record<string, unknown> {
  const directArgs = ctx.resolvedInputs.arguments;
  if (directArgs && typeof directArgs === "object" && !Array.isArray(directArgs)) {
    return directArgs as Record<string, unknown>;
  }

  if (ctx.node.config.arguments && typeof ctx.node.config.arguments === "object" && !Array.isArray(ctx.node.config.arguments)) {
    return ctx.node.config.arguments as Record<string, unknown>;
  }

  return ctx.resolvedInputs;
}

function resolveToolName(tools: McpTool[], operation: MementoOperation): string {
  const exact = tools.find((tool) => tool.name === operation);
  if (exact) {
    return exact.name;
  }

  const suffix = tools.find((tool) => tool.name.endsWith(`__${operation}`) || tool.name.endsWith(`.${operation}`) || tool.name.endsWith(`/${operation}`));
  if (suffix) {
    return suffix.name;
  }

  throw new Error(`memento MCP server does not expose a ${operation} tool`);
}

function getHandle(ctx: InvokeContext): Promise<MementoHandle> {
  const runtime = ctx.runtime;
  const options = getClientOptions(ctx);
  const resourceKey = `memento:${ctx.node.id}:${options.command}:${options.args?.join(" ") ?? ""}`;

  const factory = async (): Promise<MementoHandle> => {
    const client = new MCPStdioClient(options);
    await client.initialize();
    const tools = await client.listTools();
    runtime?.registerCleanup(() => client.close());
    return {
      tools,
      call: async (operation, args) => client.callTool(resolveToolName(tools, operation), args),
    };
  };

  if (!runtime) {
    return factory();
  }

  return runtime.getOrCreateResource(resourceKey, factory);
}

function buildMockResult(operation: MementoOperation, args: Record<string, unknown>): unknown {
  switch (operation) {
    case "remember":
      return { operation, stored: true, entry: args };
    case "recall":
      return {
        operation,
        fragments: [{
          id: "mock-memory-1",
          topic: typeof args.topic === "string" ? args.topic : "mock-topic",
          content: `Mock recall result for ${JSON.stringify(args)}`,
        }],
      };
    case "forget":
      return { operation, deleted: 1, query: args };
  }
}

class MementoAdapter implements RuntimeAdapter {
  readonly id = mementoAdapterId;

  supports(nodeType: string): boolean {
    return nodeType === "memory.memento";
  }

  async *invoke(ctx: InvokeContext): AsyncIterable<InvokeEvent> {
    try {
      const operation = getOperation(ctx);
      const args = getToolArgs(ctx);

      if (process.env.LOOM_MOCK === "1") {
        yield { kind: "final", output: buildMockResult(operation, args) };
        return;
      }

      const handle = await getHandle(ctx);
      const result = await handle.call(operation, args);
      yield { kind: "final", output: result };
    } catch (error) {
      yield {
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

export const mementoAdapter = new MementoAdapter();
