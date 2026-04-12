import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const traceDir = path.join(workspaceRoot, ".loom");
const traceDbPath = path.join(traceDir, "traces.db");

mkdirSync(traceDir, { recursive: true });

const database = new DatabaseSync(traceDbPath);
database.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    flow_name TEXT NOT NULL,
    flow_path TEXT NOT NULL,
    requested_inputs TEXT NOT NULL,
    outputs TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS node_results (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    output TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, node_id),
    FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
  );
`);

for (const columnName of ["started_at", "finished_at"]) {
  try {
    database.exec(`ALTER TABLE node_results ADD COLUMN ${columnName} TEXT`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(`duplicate column name: ${columnName}`)) {
      throw error;
    }
  }
}

try {
  database.exec("ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'success'");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("duplicate column name: status")) {
    throw error;
  }
}

export interface PersistedRun {
  runId: string;
  flowName: string;
  flowPath: string;
  userPrompt: string;
  output: string;
  status: "success" | "failed" | "aborted";
  agentResults: Array<{
    agentName: string;
    output: string;
    startedAt?: string;
    finishedAt?: string;
  }>;
}

export interface PersistedRunSummary {
  runId: string;
  flowName: string;
  status: "success" | "failed" | "aborted";
  createdAt: string;
  agentCount: number;
}

export interface PersistedAgentResult {
  agentName: string;
  output: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface PersistedRunDetail {
  runId: string;
  flowName: string;
  flowPath: string;
  userPrompt: string;
  output: string;
  status: "success" | "failed" | "aborted";
  createdAt: string;
  agentResults: PersistedAgentResult[];
}

export function getTraceDbPath(): string {
  return traceDbPath;
}

export function persistRun(run: PersistedRun): void {
  const insertRun = database.prepare(`
    INSERT INTO runs (run_id, flow_name, flow_path, requested_inputs, outputs, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAgentResult = database.prepare(`
    INSERT INTO node_results (run_id, node_id, output, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN");

  try {
    insertRun.run(
      run.runId,
      run.flowName,
      run.flowPath,
      JSON.stringify(run.userPrompt),
      JSON.stringify(run.output),
      run.status,
    );

    for (const agentResult of run.agentResults) {
      insertAgentResult.run(
        run.runId,
        agentResult.agentName,
        JSON.stringify(agentResult.output),
        agentResult.startedAt ?? null,
        agentResult.finishedAt ?? null,
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function listRuns(
  page: number,
  pageSize: number,
  filters?: { keyword?: string; status?: "success" | "failed" | "aborted" },
): PersistedRunSummary[] {
  const offset = (page - 1) * pageSize;
  const conditions: string[] = [];
  const values: Array<string | number> = [];

  if (filters?.keyword?.trim()) {
    const keyword = `%${filters.keyword.trim()}%`;
    conditions.push("(runs.flow_name LIKE ? OR runs.flow_path LIKE ? OR runs.requested_inputs LIKE ? OR runs.outputs LIKE ?)");
    values.push(keyword, keyword, keyword, keyword);
  }

  if (filters?.status) {
    conditions.push("runs.status = ?");
    values.push(filters.status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const statement = database.prepare(`
    SELECT runs.run_id, runs.flow_name, runs.status, runs.created_at, COUNT(node_results.node_id) AS agent_count
    FROM runs
    LEFT JOIN node_results ON node_results.run_id = runs.run_id
    ${whereClause}
    GROUP BY runs.run_id
    ORDER BY runs.created_at DESC, runs.run_id DESC
    LIMIT ? OFFSET ?
  `);

  return statement.all(...values, pageSize, offset).map((row) => {
    const typedRow = row as Record<string, unknown>;
    return {
      runId: String(typedRow.run_id),
      flowName: String(typedRow.flow_name),
      status: String(typedRow.status) as PersistedRunSummary["status"],
      createdAt: String(typedRow.created_at),
      agentCount: Number(typedRow.agent_count),
    };
  });
}

export function getRun(runId: string): PersistedRunDetail | null {
  const runStatement = database.prepare(`
    SELECT run_id, flow_name, flow_path, requested_inputs, outputs, status, created_at
    FROM runs
    WHERE run_id = ?
  `);
  const runRow = runStatement.get(runId) as Record<string, unknown> | undefined;

  if (!runRow) {
    return null;
  }

  const agentResultsStatement = database.prepare(`
    SELECT node_id, output, started_at, finished_at, created_at
    FROM node_results
    WHERE run_id = ?
    ORDER BY created_at ASC, node_id ASC
  `);
  const agentResults = agentResultsStatement.all(runId).map((row) => {
    const typedRow = row as Record<string, unknown>;
    return {
      agentName: String(typedRow.node_id),
      output: JSON.parse(String(typedRow.output)) as string,
      startedAt: typedRow.started_at == null ? null : String(typedRow.started_at),
      finishedAt: typedRow.finished_at == null ? null : String(typedRow.finished_at),
      createdAt: String(typedRow.created_at),
    };
  });

  return {
    runId: String(runRow.run_id),
    flowName: String(runRow.flow_name),
    flowPath: String(runRow.flow_path),
    userPrompt: JSON.parse(String(runRow.requested_inputs)) as string,
    output: JSON.parse(String(runRow.outputs)) as string,
    status: String(runRow.status) as PersistedRunDetail["status"],
    createdAt: String(runRow.created_at),
    agentResults,
  };
}

export function resetTraceStore(): void {
  database.exec("DELETE FROM node_results; DELETE FROM runs;");
}
