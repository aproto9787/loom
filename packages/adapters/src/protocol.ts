import type { AgentEvent } from "./types.js";

const DELEGATE_LINE = /^DELEGATE\s+([A-Za-z0-9._-]+)\s*:\s*([\s\S]+)$/i;

function normalizeDelegate(value: unknown): { childAgent: string; reason: string } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const childAgent = typeof record.childAgent === "string"
    ? record.childAgent
    : typeof record.delegate === "string"
      ? record.delegate
      : undefined;
  const reason = typeof record.reason === "string"
    ? record.reason
    : typeof record.input === "string"
      ? record.input
      : undefined;

  if (!childAgent || !reason) {
    return undefined;
  }

  const normalizedChildAgent = childAgent.trim();
  const normalizedReason = reason.trim();
  if (normalizedChildAgent.length === 0 || normalizedReason.length === 0) {
    return undefined;
  }

  return {
    childAgent: normalizedChildAgent,
    reason: normalizedReason,
  };
}

export function parseParallelDelegationDirective(output: string): Array<{ childAgent: string; reason: string }> | undefined {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!Array.isArray(parsed.parallel)) {
      return undefined;
    }

    const directives = parsed.parallel
      .map((entry) => normalizeDelegate(entry))
      .filter((entry): entry is { childAgent: string; reason: string } => Boolean(entry));

    return directives.length > 0 ? directives : undefined;
  } catch {
    return undefined;
  }
}

export function parseDelegationDirective(output: string): { childAgent: string; reason: string } | undefined {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const normalized = normalizeDelegate(parsed);
    if (normalized) {
      return normalized;
    }
  } catch {
    // Not JSON. Fall through to line-based parsing.
  }

  const lineMatch = DELEGATE_LINE.exec(trimmed);
  if (!lineMatch) {
    return undefined;
  }

  const [, childAgent, reason] = lineMatch;
  return {
    childAgent: childAgent.trim(),
    reason: reason.trim(),
  };
}

export function* emitMockEvents(output: string): Generator<AgentEvent, void, undefined> {
  for (const word of output.split(/(\s+)/)) {
    if (word.length > 0) {
      yield { type: "token", content: word };
    }
  }

  const parallelDelegation = parseParallelDelegationDirective(output);
  if (parallelDelegation) {
    for (const delegation of parallelDelegation) {
      yield { type: "delegate", ...delegation };
    }
    return;
  }

  const delegation = parseDelegationDirective(output);
  if (delegation) {
    yield { type: "delegate", ...delegation };
    return;
  }

  yield { type: "complete", output };
}
