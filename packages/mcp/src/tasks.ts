import type { RunSubagentTaskResult } from "@aproto9787/heddle-runtime";

export const DEFAULT_SYNC_WAIT_CAP_MS = 90_000;

export interface TaskState {
  taskId: string;
  agent: string;
  status: "running" | RunSubagentTaskResult["status"];
  promise: Promise<RunSubagentTaskResult>;
  controller: AbortController;
  result?: RunSubagentTaskResult;
  error?: string;
}
