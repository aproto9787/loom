import type { LoomFlow } from "@loom/core";

export interface SaveFlowResult {
  flowPath: string;
}

export async function saveFlow(
  origin: string,
  flowPath: string,
  flow: LoomFlow,
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
