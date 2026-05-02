export interface HeddleMcpContext {
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

export function buildContext(env: NodeJS.ProcessEnv): HeddleMcpContext {
  const flowPath = env.HEDDLE_FLOW_PATH;
  if (!flowPath) {
    throw new Error("HEDDLE_FLOW_PATH is required for heddle mcp");
  }
  const subagentBin = env.HEDDLE_SUBAGENT_BIN;
  if (!subagentBin) {
    throw new Error("HEDDLE_SUBAGENT_BIN is required for heddle mcp");
  }
  return {
    flowPath,
    cwd: env.HEDDLE_FLOW_CWD ?? process.cwd(),
    currentAgentName: env.HEDDLE_AGENT ?? "leader",
    parentDepth: parsePositiveInteger(env.HEDDLE_PARENT_DEPTH, 0),
    runId: env.HEDDLE_RUN_ID,
    serverOrigin: env.HEDDLE_SERVER_ORIGIN,
    subagentBin,
  };
}
