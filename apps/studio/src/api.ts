import type { FlowDefinition } from "@aproto9787/loom-core";

export interface SaveFlowResult {
  flowPath: string;
}

export interface DuplicateFlowResult {
  flowPath: string;
  flow: FlowDefinition;
}

export interface OracleAdvisorStatus {
  plugin: {
    id: "oracle";
    displayName: "Oracle";
    kind: "external-advisor";
  };
  oracle: {
    command: string;
    available: boolean;
    path?: string;
  };
  oracleMcp: {
    command: string;
    available: boolean;
    path?: string;
  };
  npxFallback: {
    command: "npx";
    package: "@steipete/oracle";
    available: boolean;
  };
  attribution: "Oracle by steipete";
  note: string;
}

export interface OracleAdvisorResult {
  plugin: {
    id: "oracle";
    kind: "external-advisor";
  };
  status: "done" | "error" | "unavailable";
  provider?: "oracle" | "npx";
  command: string[];
  exitCode?: number;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
  installHint?: string;
  attribution: "Oracle by steipete";
}

export interface OracleRunResult {
  runId: string;
  result: OracleAdvisorResult;
}

export async function saveFlow(
  origin: string,
  flowPath: string,
  flow: FlowDefinition,
): Promise<SaveFlowResult> {
  const response = await fetch(`${origin}/flows/save`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowPath, flow }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`save failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
  }
  return (await response.json()) as SaveFlowResult;
}

export async function duplicateFlow(
  origin: string,
  sourcePath: string,
  name: string,
): Promise<DuplicateFlowResult> {
  const response = await fetch(`${origin}/flows/duplicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourcePath, name }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`duplicate failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
  }
  return (await response.json()) as DuplicateFlowResult;
}

export async function getOracleStatus(origin: string): Promise<OracleAdvisorStatus> {
  const response = await fetch(`${origin}/plugins/oracle/status`);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`oracle status failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
  }
  return (await response.json()) as OracleAdvisorStatus;
}

export async function runOracleAdvisor(
  origin: string,
  request: {
    prompt: string;
    files: string[];
    args: string[];
    timeoutSeconds: number;
    useNpxFallback: boolean;
  },
): Promise<OracleRunResult> {
  const response = await fetch(`${origin}/plugins/oracle/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`oracle run failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
  }
  return (await response.json()) as OracleRunResult;
}
