import type { ReactNode } from "react";
import type { AgentConfig } from "@loom/core";
import { DelegationRowEditor } from "./AgentConfigForm.js";
import { getAgentAtPath, useRunStore } from "./store.js";

function collectRelatedAgentNames(root: AgentConfig, path: string[]): string[] {
  const currentName = path[path.length - 1];
  const siblingPath = path.slice(0, -1);
  const siblingParent = getAgentAtPath(root, siblingPath);
  const siblings = (siblingParent?.agents ?? []).map((entry) => entry.name);
  const current = getAgentAtPath(root, path);
  const children = (current?.agents ?? []).map((entry) => entry.name);
  return [...new Set([...siblings, ...children].filter((name) => name !== currentName))].sort((a, b) => a.localeCompare(b));
}

function renderAgentSections(
  root: AgentConfig,
  agent: AgentConfig,
  path: string[],
  updateAgent: (path: string[], config: Partial<AgentConfig>) => void,
): ReactNode[] {
  const pathLabel = path.join("/");
  const relatedAgentOptions = collectRelatedAgentNames(root, path);
  const section = (
    <section
      key={pathLabel}
      className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/40 p-4"
    >
      <div>
        <h2 className="m-0 text-sm font-semibold text-slate-100">{`${agent.name} (${pathLabel})`}</h2>
        <p className="m-0 mt-1 text-xs leading-5 text-slate-500">
          Configure explicit delegation rules for this agent.
        </p>
      </div>
      <DelegationRowEditor
        rules={agent.delegation ?? []}
        options={relatedAgentOptions}
        onChange={(rules) => updateAgent(path, { delegation: rules })}
      />
    </section>
  );

  const children = (agent.agents ?? []).flatMap((child) =>
    renderAgentSections(root, child, [...path, child.name], updateAgent),
  );

  return [section, ...children];
}

export default function DelegationTab() {
  const flowDraft = useRunStore((state) => state.flowDraft);
  const updateAgent = useRunStore((state) => state.updateAgent);

  if (!flowDraft) {
    return (
      <div className="p-5">
        <p className="m-0 rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-6 text-sm text-slate-400">
          Load a flow to manage delegation rules.
        </p>
      </div>
    );
  }

  const rootPath = [flowDraft.orchestrator.name];

  return (
    <div className="flex flex-col gap-4 p-5">
      {renderAgentSections(flowDraft.orchestrator, flowDraft.orchestrator, rootPath, updateAgent)}
    </div>
  );
}
