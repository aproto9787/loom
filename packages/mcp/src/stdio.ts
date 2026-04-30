import readline from "node:readline";
import { errorResponse, type JsonRpcRequest } from "./json-rpc.js";
import { LoomMcpServer, type LoomMcpServerOptions } from "./server.js";

export async function runLoomMcpServer(options: LoomMcpServerOptions = {}): Promise<void> {
  const server = new LoomMcpServer(options);
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const rl = readline.createInterface({ input });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      output.write(`${JSON.stringify(errorResponse(null, -32700, "parse error"))}\n`);
      continue;
    }
    const response = await server.handleRequest(request);
    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
