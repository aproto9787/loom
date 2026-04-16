import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentType, RunRecord, RunSource, RunStatus, RunSummary } from "@loom/core";

export type PersistedRunEventType = "user" | "assistant" | "tool_use" | "tool_result" | "error";

export interface PersistedRunEvent {
  runId: string;
  ts: number;
  type: PersistedRunEventType;
  summary?: string;
  toolName?: string;
  agentName?: string;
  agentDepth?: number;
  raw?: unknown;
}

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

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    summary TEXT,
    tool_name TEXT,
    agent_name TEXT,
    agent_depth INTEGER,
    raw TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
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
  "ALTER TABLE runs ADD COLUMN cwd TEXT",
  "ALTER TABLE runs ADD COLUMN agent_type TEXT",
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
  cwd?: string | null;
  agentType?: string | null;
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
  cwd: string | null;
  agentResults: PersistedAgentResult[];
}

export function getTraceDbPath(): string {
  return traceDbPath;
}

export function persistRun(run: PersistedRun): void {
  const insertRun = database.prepare(`
    INSERT INTO runs (run_id, flow_name, flow_path, requested_inputs, outputs, status, source, exit_code, started_at, ended_at, cwd, agent_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      run.cwd ?? null,
      run.agentType ?? null,
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
    INSERT INTO runs (run_id, flow_name, flow_path, requested_inputs, outputs, status, source, exit_code, started_at, ended_at, cwd, agent_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    run.cwd ?? null,
    run.agentType ?? null,
  );
}

export function updateRunRecord(
  runId: string,
  updates: {
    status?: RunStatus;
    output?: string;
    exitCode?: number;
    endedAt?: string;
    cwd?: string | null;
  },
): boolean {
  const current = database.prepare(`
    SELECT outputs, status, source, exit_code, started_at, ended_at, cwd
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
  const nextCwd = updates.cwd ?? (current.cwd == null ? null : String(current.cwd));

  database.prepare(`
    UPDATE runs
    SET outputs = ?, status = ?, exit_code = ?, ended_at = ?, cwd = ?
    WHERE run_id = ?
  `).run(JSON.stringify(nextOutput), nextStatus, nextExitCode, nextEndedAt, nextCwd, runId);

  return true;
}

const staleThresholdMs = 10 * 60 * 1000;

export function markStaleRuns(now = Date.now()): number {
  const threshold = new Date(now - staleThresholdMs).toISOString();
  const result = database.prepare(`
    UPDATE runs
    SET status = 'stale'
    WHERE status = 'running'
      AND COALESCE(ended_at, started_at, created_at) < ?
      AND COALESCE(started_at, created_at) < ?
  `).run(threshold, threshold);

  return Number(result.changes ?? 0);
}

export function listRuns(
  page: number,
  pageSize: number,
  filters?: { keyword?: string; status?: RunStatus | "stale" },
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
    SELECT
      runs.run_id,
      runs.flow_name,
      runs.status,
      runs.source,
      runs.exit_code,
      runs.started_at,
      runs.ended_at,
      runs.created_at,
      runs.cwd,
      runs.agent_type,
      (SELECT COUNT(node_id) FROM node_results WHERE node_results.run_id = runs.run_id) AS agent_count,
      (SELECT COUNT(id) FROM events WHERE events.run_id = runs.run_id) AS event_count,
      (SELECT MAX(ts) FROM events WHERE events.run_id = runs.run_id) AS last_event_at,
      (SELECT json_object('type', type, 'toolName', tool_name, 'summary', summary, 'agentName', agent_name)
         FROM events WHERE events.run_id = runs.run_id
         ORDER BY events.ts DESC, events.id DESC LIMIT 1) AS latest_event_json
    FROM runs
    ${whereClause}
    ORDER BY COALESCE(runs.started_at, runs.created_at) DESC, runs.run_id DESC
    LIMIT ? OFFSET ?
  `);

  return statement.all(...values, pageSize, offset).map((row) => {
    const typedRow = row as Record<string, unknown>;
    const latestEventJson = typedRow.latest_event_json == null ? null : String(typedRow.latest_event_json);
    let latestActivity: string | undefined;
    let activeAgent: string | undefined;
    if (latestEventJson) {
      try {
        const parsed = JSON.parse(latestEventJson) as {
          type?: string;
          toolName?: string | null;
          summary?: string | null;
          agentName?: string | null;
        };
        const type = parsed.type ?? "";
        const toolName = parsed.toolName ?? undefined;
        const summary = parsed.summary ?? undefined;
        if (toolName) {
          latestActivity = `${type}: ${toolName}`;
        } else if (summary) {
          latestActivity = `${type}: ${summary.slice(0, 80)}`;
        } else if (type) {
          latestActivity = type;
        }
        if (parsed.agentName) {
          activeAgent = parsed.agentName;
        }
      } catch {
        // ignore malformed JSON from sqlite
      }
    }
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
      cwd: typedRow.cwd == null ? null : String(typedRow.cwd),
      agentType: typedRow.agent_type == null ? undefined : String(typedRow.agent_type) as AgentType,
      eventCount: Number(typedRow.event_count ?? 0),
      lastEventAt: typedRow.last_event_at == null ? undefined : Number(typedRow.last_event_at),
      latestActivity,
      activeAgent,
    };
  });
}

export function getRun(runId: string): PersistedRunDetail | null {
  const runStatement = database.prepare(`
    SELECT run_id, flow_name, flow_path, requested_inputs, outputs, status, source, exit_code, started_at, ended_at, created_at, cwd
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
  const eventsStatement = database.prepare(`
    SELECT run_id, ts, type, summary, tool_name, agent_name, agent_depth, raw
    FROM events
    WHERE run_id = ?
    ORDER BY ts ASC, id ASC
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
  const events = eventsStatement.all(runId).map((row) => {
    const typedRow = row as Record<string, unknown>;
    return {
      runId: String(typedRow.run_id),
      ts: Number(typedRow.ts),
      type: String(typedRow.type) as PersistedRunEventType,
      summary: typedRow.summary == null ? undefined : String(typedRow.summary),
      toolName: typedRow.tool_name == null ? undefined : String(typedRow.tool_name),
      agentName: typedRow.agent_name == null ? undefined : String(typedRow.agent_name),
      agentDepth: typedRow.agent_depth == null ? undefined : Number(typedRow.agent_depth),
      raw: typedRow.raw == null ? undefined : JSON.parse(String(typedRow.raw)) as unknown,
    } satisfies PersistedRunEvent;
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
    cwd: runRow.cwd == null ? null : String(runRow.cwd),
    agentResults,
    events,
  } as PersistedRunDetail & { events: PersistedRunEvent[] };
}

export function listRunEvents(runId: string): PersistedRunEvent[] {
  return database.prepare(`
    SELECT run_id, ts, type, summary, tool_name, agent_name, agent_depth, raw
    FROM events
    WHERE run_id = ?
    ORDER BY ts ASC, id ASC
  `).all(runId).map((row) => {
    const typedRow = row as Record<string, unknown>;
    return {
      runId: String(typedRow.run_id),
      ts: Number(typedRow.ts),
      type: String(typedRow.type) as PersistedRunEventType,
      summary: typedRow.summary == null ? undefined : String(typedRow.summary),
      toolName: typedRow.tool_name == null ? undefined : String(typedRow.tool_name),
      agentName: typedRow.agent_name == null ? undefined : String(typedRow.agent_name),
      agentDepth: typedRow.agent_depth == null ? undefined : Number(typedRow.agent_depth),
      raw: typedRow.raw == null ? undefined : JSON.parse(String(typedRow.raw)) as unknown,
    } satisfies PersistedRunEvent;
  });
}

export function appendRunEvent(event: PersistedRunEvent): void {
  database.prepare(`
    INSERT INTO events (run_id, ts, type, summary, tool_name, agent_name, agent_depth, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.runId,
    event.ts,
    event.type,
    event.summary ?? null,
    event.toolName ?? null,
    event.agentName ?? null,
    event.agentDepth ?? null,
    event.raw === undefined ? null : JSON.stringify(event.raw),
  );
}

export function resetTraceStore(): void {
  database.exec("DELETE FROM events; DELETE FROM node_results; DELETE FROM runs;");
}
