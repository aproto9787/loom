import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// A very small Model Context Protocol stdio client. It speaks the
// JSON-RPC 2.0 subset that Loom needs right now (initialize + tools/list)
// using newline-delimited JSON over stdin/stdout, which matches the
// "ndjson" framing that the current Claude Code hosts use.
//
// The client is intentionally dependency-free — pulling in the full
// @modelcontextprotocol/sdk would dwarf the rest of the v0.1 slice.

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class MCPStdioClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (value: JsonRpcResponse) => void>();
  private closed = false;

  constructor(options: McpClientOptions) {
    this.proc = spawn(options.command, options.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.ingest(chunk));
    this.proc.on("error", (error) => this.rejectAll(error));
    this.proc.on("exit", () => {
      this.closed = true;
      this.rejectAll(new Error("mcp subprocess exited"));
    });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (typeof parsed.id === "number") {
            const resolver = this.pending.get(parsed.id);
            if (resolver) {
              this.pending.delete(parsed.id);
              resolver(parsed);
            }
          }
        } catch {
          // Non-JSON line, ignore (probably a log line).
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private rejectAll(error: Error): void {
    for (const resolver of this.pending.values()) {
      resolver({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: error.message } });
    }
    this.pending.clear();
  }

  private request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    if (this.closed) {
      return Promise.reject(new Error("mcp client is closed"));
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(`${payload}\n`);
    });
  }

  async initialize(): Promise<void> {
    const response = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      clientInfo: { name: "loom", version: "0.1.0" },
      capabilities: {},
    });
    if (response.error) {
      throw new Error(`mcp initialize failed: ${response.error.message}`);
    }
  }

  async listTools(): Promise<McpTool[]> {
    const response = await this.request("tools/list");
    if (response.error) {
      throw new Error(`mcp tools/list failed: ${response.error.message}`);
    }
    const result = response.result as { tools?: McpTool[] } | undefined;
    return result?.tools ?? [];
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    this.proc.kill("SIGTERM");
  }
}
