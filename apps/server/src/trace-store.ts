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

export interface PersistedRun {
  runId: string;
  flowName: string;
  flowPath: string;
  requestedInputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  nodeResults: Array<{
    nodeId: string;
    output: unknown;
    startedAt?: string;
    finishedAt?: string;
  }>;
}

export interface PersistedRunSummary {
  runId: string;
  flowName: string;
  createdAt: string;
  nodeCount: number;
}

export interface PersistedNodeResult {
  nodeId: string;
  output: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface PersistedRunDetail {
  runId: string;
  flowName: string;
  flowPath: string;
  requestedInputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  createdAt: string;
  nodeResults: PersistedNodeResult[];
}

export function getTraceDbPath(): string {
  return traceDbPath;
}

export function persistRun(run: PersistedRun): void {
  const insertRun = database.prepare(`
    INSERT INTO runs (run_id, flow_name, flow_path, requested_inputs, outputs)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertNodeResult = database.prepare(`
    INSERT INTO node_results (run_id, node_id, output, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN");

  try {
    insertRun.run(
      run.runId,
      run.flowName,
      run.flowPath,
      JSON.stringify(run.requestedInputs),
      JSON.stringify(run.outputs),
    );

    for (const nodeResult of run.nodeResults) {
      insertNodeResult.run(
        run.runId,
        nodeResult.nodeId,
        JSON.stringify(nodeResult.output),
        nodeResult.startedAt ?? null,
        nodeResult.finishedAt ?? null,
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function listRuns(page: number, pageSize: number): PersistedRunSummary[] {
  const offset = (page - 1) * pageSize;
  const statement = database.prepare(`
    SELECT runs.run_id, runs.flow_name, runs.created_at, COUNT(node_results.node_id) AS node_count
    FROM runs
    LEFT JOIN node_results ON node_results.run_id = runs.run_id
    GROUP BY runs.run_id
    ORDER BY runs.created_at DESC, runs.run_id DESC
    LIMIT ? OFFSET ?
  `);

  return statement.all(pageSize, offset).map((row) => {
    const typedRow = row as Record<string, unknown>;
    return {
      runId: String(typedRow.run_id),
      flowName: String(typedRow.flow_name),
      createdAt: String(typedRow.created_at),
      nodeCount: Number(typedRow.node_count),
    };
  });
}

export function getRun(runId: string): PersistedRunDetail | null {
  const runStatement = database.prepare(`
    SELECT run_id, flow_name, flow_path, requested_inputs, outputs, created_at
    FROM runs
    WHERE run_id = ?
  `);
  const runRow = runStatement.get(runId) as Record<string, unknown> | undefined;

  if (!runRow) {
    return null;
  }

  const nodeResultsStatement = database.prepare(`
    SELECT node_id, output, started_at, finished_at, created_at
    FROM node_results
    WHERE run_id = ?
    ORDER BY created_at ASC, node_id ASC
  `);
  const nodeResults = nodeResultsStatement.all(runId).map((row) => {
    const typedRow = row as Record<string, unknown>;
    return {
      nodeId: String(typedRow.node_id),
      output: JSON.parse(String(typedRow.output)),
      startedAt: typedRow.started_at == null ? null : String(typedRow.started_at),
      finishedAt: typedRow.finished_at == null ? null : String(typedRow.finished_at),
      createdAt: String(typedRow.created_at),
    };
  });

  return {
    runId: String(runRow.run_id),
    flowName: String(runRow.flow_name),
    flowPath: String(runRow.flow_path),
    requestedInputs: JSON.parse(String(runRow.requested_inputs)) as Record<string, unknown>,
    outputs: JSON.parse(String(runRow.outputs)) as Record<string, unknown>,
    createdAt: String(runRow.created_at),
    nodeResults,
  };
}

export function resetTraceStore(): void {
  database.exec("DELETE FROM node_results; DELETE FROM runs;");
}
