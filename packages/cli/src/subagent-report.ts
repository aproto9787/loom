export function initialReport(name: string): string {
  return `status: blocked\nsummary:\n  - ${name} did not start\n`;
}

export function isCompleteReport(report: string, name: string): boolean {
  const trimmed = report.trim();
  if (!trimmed || trimmed === initialReport(name).trim()) {
    return false;
  }

  return /^status:\s*(done|blocked|needs_decision)\s*$/m.test(report)
    && /^summary:\s*$/m.test(report)
    && /^\s*-\s+\S/m.test(report);
}

function compact(value: string, max = 240): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object") return "";
      const record = entry as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractCodexFinalMessage(stdout: string): string {
  let finalMessage = "";
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const item = parsed.type === "item.completed" && parsed.item && typeof parsed.item === "object"
      ? parsed.item as Record<string, unknown>
      : parsed;
    if (item.type === "message" && item.role === "assistant") {
      const text = extractTextContent(item.content);
      if (text) finalMessage = text;
    }
  }
  return finalMessage;
}

export function recoverReport(input: {
  name: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}): string {
  const finalMessage = extractCodexFinalMessage(input.stdout);
  if (isCompleteReport(finalMessage, input.name)) {
    return finalMessage.endsWith("\n") ? finalMessage : `${finalMessage}\n`;
  }

  const summary = [
    `${input.name} did not write a valid REPORT file`,
    `child exitCode: ${input.exitCode}`,
    compact(input.stderr) ? `child stderr: ${compact(input.stderr)}` : undefined,
    compact(finalMessage) ? `child final message: ${compact(finalMessage)}` : undefined,
    !finalMessage && compact(input.stdout) ? `child stdout: ${compact(input.stdout)}` : undefined,
  ].filter(Boolean);

  return [
    "status: blocked",
    "summary:",
    ...summary.map((entry) => `  - ${entry}`),
    "blockers:",
    "  - Heddle could not recover a valid REPORT from Codex stdout",
    "",
  ].join("\n");
}
