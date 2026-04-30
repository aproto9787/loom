export interface DelegateArguments {
  agent?: string;
  briefing?: string;
  timeoutSeconds?: number;
  wait?: boolean;
}

export interface DelegateManyArguments {
  tasks?: DelegateArguments[];
  timeoutSeconds?: number;
  wait?: boolean;
}

export interface ReadReportArguments {
  taskId?: string;
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseTimeoutSeconds(object: Record<string, unknown>, fallback: number): number {
  if (object.timeoutSeconds === undefined) return fallback;
  if (typeof object.timeoutSeconds !== "number" || !Number.isFinite(object.timeoutSeconds) || object.timeoutSeconds < 1) {
    throw new Error("timeoutSeconds must be a positive number");
  }
  return object.timeoutSeconds;
}

export function parseDelegateArguments(
  value: unknown,
  fallbackTimeoutSeconds = 900,
  defaultWait = true,
): Required<DelegateArguments> {
  const object = asObject(value);
  const agent = typeof object.agent === "string" ? object.agent.trim() : "";
  const briefing = typeof object.briefing === "string" ? object.briefing.trim() : "";
  const timeoutSeconds = parseTimeoutSeconds(object, fallbackTimeoutSeconds);
  const wait = typeof object.wait === "boolean" ? object.wait : defaultWait;
  if (!agent) throw new Error("agent is required");
  if (!briefing) throw new Error("briefing is required");
  return { agent, briefing, timeoutSeconds, wait };
}

export function parseDelegateManyArguments(value: unknown): Required<DelegateManyArguments> {
  const object = asObject(value);
  const timeoutSeconds = parseTimeoutSeconds(object, 900);
  const wait = typeof object.wait === "boolean" ? object.wait : false;
  const tasks = Array.isArray(object.tasks)
    ? object.tasks.map((task) => parseDelegateArguments(task, timeoutSeconds, wait))
    : [];
  if (tasks.length === 0) throw new Error("tasks must contain at least one task");
  return { tasks, timeoutSeconds, wait };
}

export function parseReadReportArguments(value: unknown): Required<ReadReportArguments> {
  const object = asObject(value);
  const taskId = typeof object.taskId === "string" ? object.taskId.trim() : "";
  if (!taskId) throw new Error("taskId is required");
  return { taskId };
}
