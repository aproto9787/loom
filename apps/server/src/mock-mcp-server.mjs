#!/usr/bin/env node
// A tiny self-contained MCP server used by Heddle demos so that the
// mcp.server node can spawn a real subprocess and walk through a real
// JSON-RPC handshake without requiring any external binary. It speaks
// newline-delimited JSON on stdin/stdout and implements just enough of
// the protocol to answer `initialize` and `tools/list`.

import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

const TOOLS = [
  {
    name: "echo",
    description: "Echo back whatever text was supplied.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "upper",
    description: "Return the supplied text in upper case.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = request;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "heddle-mock-mcp", version: "0.1.0" },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const text = params?.arguments?.text ?? "";
    if (toolName === "echo") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      return;
    }
    if (toolName === "upper") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(text).toUpperCase() }] },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `unknown tool: ${toolName}` },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32601, message: `method not implemented: ${method}` },
  });
});

process.on("SIGTERM", () => process.exit(0));
