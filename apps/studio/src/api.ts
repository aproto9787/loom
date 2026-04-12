import type { FlowDefinition } from "@loom/core";

export interface SaveFlowResult {
  flowPath: string;
}

export interface DuplicateFlowResult {
  flowPath: string;
  flow: FlowDefinition;
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
