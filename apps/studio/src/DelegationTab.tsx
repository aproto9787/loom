import type { ReactNode } from "react";
import type { AgentConfig } from "@aproto9787/heddle-core";
import { DelegationRowEditor } from "./AgentConfigForm.js";
import { darkCard, darkCardMuted } from "./panelStyles.js";
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
  const trail = path.slice(0, -1).join(" / ") || "root";
  const section = (
    <section key={pathLabel} className={`flex flex-col gap-4 p-5 ${darkCard}`}>
      <header className="flex flex-col gap-3 border-b border-slate-800 pb-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-base font-semibold text-slate-100">{agent.name}</h2>
            <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-200">
              {agent.type}
            </span>
          </div>
          <p className="m-0 mt-2 text-xs uppercase tracking-[0.18em] text-slate-500">{trail}</p>
          <p className="m-0 mt-2 text-sm leading-6 text-slate-400">
            Configure explicit delegation rules for this agent.
          </p>
        </div>
      </header>
      <div className={`p-4 ${darkCardMuted}`}>
        <DelegationRowEditor
          rules={agent.delegation ?? []}
          options={relatedAgentOptions}
          onChange={(rules) => updateAgent(path, { delegation: rules })}
        />
      </div>
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
    <div className="flex flex-col gap-5 p-5">
      <section className={`p-5 ${darkCardMuted}`}>
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Delegation</p>
        <p className="m-0 mt-2 text-sm leading-6 text-slate-500">
          Edit delegation rules per agent. Targets are limited to sibling and child agents.
        </p>
      </section>
      {renderAgentSections(flowDraft.orchestrator, flowDraft.orchestrator, rootPath, updateAgent)}
    </div>
  );
}
