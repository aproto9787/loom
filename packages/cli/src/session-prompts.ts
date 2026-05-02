export function buildHeadlessPrompt(instructions: string, userPrompt: string): string {
  const parts = [];
  if (instructions.trim()) {
    parts.push(`# Heddle instructions\n${instructions.trim()}`);
  }
  parts.push(`# User task\n${userPrompt.trim()}`);
  return parts.join("\n\n");
}

export function buildInteractiveCodexAgentsMd(
  globalAgents: string | undefined,
  instructions: string,
): string {
  const parts = [];
  if (globalAgents?.trim()) {
    parts.push(globalAgents.trim());
  }
  if (instructions.trim()) {
    parts.push(`# Heddle flow instructions\n${instructions.trim()}`);
  }
  parts.push([
    "# Heddle interactive session bootstrap",
    "Keep these Heddle instructions active for the whole session.",
    "Wait for the user's next task before doing any work.",
  ].join("\n"));
  return `${parts.join("\n\n")}\n`;
}
