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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, node_id),
    FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
  );
`);

export interface PersistedRun {
  runId: string;
  flowName: string;
  flowPath: string;
  requestedInputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  nodeResults: Array<{
    nodeId: string;
    output: unknown;
  }>;
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
    INSERT INTO node_results (run_id, node_id, output)
    VALUES (?, ?, ?)
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
      insertNodeResult.run(run.runId, nodeResult.nodeId, JSON.stringify(nodeResult.output));
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
