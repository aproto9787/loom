import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunRecord, RunSource, RunStatus, RunSummary } from "@loom/core";

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
    source TEXT NOT NULL DEFAULT 'server',
    exit_code INTEGER,
    started_at TEXT,
    ended_at TEXT,
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

for (const statement of [
  "ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'success'",
  "ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'server'",
  "ALTER TABLE runs ADD COLUMN exit_code INTEGER",
  "ALTER TABLE runs ADD COLUMN started_at TEXT",
  "ALTER TABLE runs ADD COLUMN ended_at TEXT",
]) {
  try {
    database.exec(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("duplicate column name")) {
      throw error;
    }
  }
}

export interface PersistedRun extends Omit<RunRecord, "createdAt" | "agentResults"> {
  agentResults: Array<{
    agentName: string;
    output: string;
    startedAt?: string;
    finishedAt?: string;
    createdAt?: string;
  }>;
}

export interface PersistedAgentResult {
  agentName: string;
  output: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface PersistedRunDetail extends Omit<RunRecord, "agentResults"> {
  createdAt: string;
  agentResults: PersistedAgentResult[];
}

export function getTraceDbPath(): string {
  return traceDbPath;
}

export function persistRun(run: PersistedRun): void {
  const insertRun = database.prepare(`
    INSERT INTO runs (run_id, flow_name, flow_path, requested_inputs, outputs, status, source, exit_code, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      run.source,
      run.exitCode ?? null,
      run.startedAt ?? null,
      run.endedAt ?? null,
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

export function createRunRecord(run: PersistedRun): void {
  const statement = database.prepare(`
    INSERT INTO runs (run_id, flow_name, flow_path, requested_inputs, outputs, status, source, exit_code, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  statement.run(
    run.runId,
    run.flowName,
    run.flowPath,
    JSON.stringify(run.userPrompt),
    JSON.stringify(run.output),
    run.status,
    run.source,
    run.exitCode ?? null,
    run.startedAt ?? null,
    run.endedAt ?? null,
  );
}

export function updateRunRecord(
  runId: string,
  updates: {
    status?: RunStatus;
    output?: string;
    exitCode?: number;
    endedAt?: string;
  },
): boolean {
  const current = database.prepare(`
    SELECT outputs, status, source, exit_code, started_at, ended_at
    FROM runs
    WHERE run_id = ?
  `).get(runId) as Record<string, unknown> | undefined;

  if (!current) {
    return false;
  }

  const nextOutput = updates.output ?? JSON.parse(String(current.outputs)) as string;
  const nextStatus = updates.status ?? String(current.status) as RunStatus;
  const nextExitCode = updates.exitCode ?? (current.exit_code == null ? null : Number(current.exit_code));
  const nextEndedAt = updates.endedAt ?? (current.ended_at == null ? null : String(current.ended_at));

  database.prepare(`
    UPDATE runs
    SET outputs = ?, status = ?, exit_code = ?, ended_at = ?
    WHERE run_id = ?
  `).run(JSON.stringify(nextOutput), nextStatus, nextExitCode, nextEndedAt, runId);

  return true;
}

export function listRuns(
  page: number,
  pageSize: number,
  filters?: { keyword?: string; status?: RunStatus },
): RunSummary[] {
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
    SELECT runs.run_id, runs.flow_name, runs.status, runs.source, runs.exit_code, runs.started_at, runs.ended_at, runs.created_at, COUNT(node_results.node_id) AS agent_count
    FROM runs
    LEFT JOIN node_results ON node_results.run_id = runs.run_id
    ${whereClause}
    GROUP BY runs.run_id
    ORDER BY COALESCE(runs.started_at, runs.created_at) DESC, runs.run_id DESC
    LIMIT ? OFFSET ?
  `);

  return statement.all(...values, pageSize, offset).map((row) => {
    const typedRow = row as Record<string, unknown>;
    return {
      runId: String(typedRow.run_id),
      flowName: String(typedRow.flow_name),
      status: String(typedRow.status) as RunStatus,
      source: String(typedRow.source) as RunSource,
      createdAt: String(typedRow.created_at),
      startedAt: typedRow.started_at == null ? undefined : String(typedRow.started_at),
      endedAt: typedRow.ended_at == null ? undefined : String(typedRow.ended_at),
      exitCode: typedRow.exit_code == null ? undefined : Number(typedRow.exit_code),
      agentCount: Number(typedRow.agent_count),
    };
  });
}

export function getRun(runId: string): PersistedRunDetail | null {
  const runStatement = database.prepare(`
    SELECT run_id, flow_name, flow_path, requested_inputs, outputs, status, source, exit_code, started_at, ended_at, created_at
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
    status: String(runRow.status) as RunStatus,
    source: String(runRow.source) as RunSource,
    exitCode: runRow.exit_code == null ? undefined : Number(runRow.exit_code),
    startedAt: runRow.started_at == null ? undefined : String(runRow.started_at),
    endedAt: runRow.ended_at == null ? undefined : String(runRow.ended_at),
    createdAt: String(runRow.created_at),
    agentResults,
  };
}

export function resetTraceStore(): void {
  database.exec("DELETE FROM node_results; DELETE FROM runs;");
}
