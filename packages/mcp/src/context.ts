export interface LoomMcpContext {
  flowPath: string;
  cwd: string;
  currentAgentName: string;
  parentDepth: number;
  runId?: string;
  serverOrigin?: string;
  subagentBin: string;
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function buildContext(env: NodeJS.ProcessEnv): LoomMcpContext {
  const flowPath = env.LOOM_FLOW_PATH;
  if (!flowPath) {
    throw new Error("LOOM_FLOW_PATH is required for loom mcp");
  }
  const subagentBin = env.LOOM_SUBAGENT_BIN;
  if (!subagentBin) {
    throw new Error("LOOM_SUBAGENT_BIN is required for loom mcp");
  }
  return {
    flowPath,
    cwd: env.LOOM_FLOW_CWD ?? process.cwd(),
    currentAgentName: env.LOOM_AGENT ?? "leader",
    parentDepth: parsePositiveInteger(env.LOOM_PARENT_DEPTH, 0),
    runId: env.LOOM_RUN_ID,
    serverOrigin: env.LOOM_SERVER_ORIGIN,
    subagentBin,
  };
}
