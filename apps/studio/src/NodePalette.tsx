import type { AgentType } from "@loom/core";

interface AgentPaletteProps {
  onAdd: (type: AgentType) => void;
  disabled?: boolean;
  selectedAgentName?: string;
}

export function NodePalette({ onAdd, disabled, selectedAgentName }: AgentPaletteProps) {
  return (
    <section className="mt-6 p-4 rounded-xl bg-white border border-slate-300 flex flex-col gap-3">
      <p className="m-0 text-xs font-semibold uppercase tracking-wider text-blue-600">
        Add agent
      </p>
      {selectedAgentName ? (
        <p className="m-0 text-xs text-slate-600 leading-snug">
          Add a sub-agent under <strong>{selectedAgentName}</strong>
        </p>
      ) : (
        <p className="m-0 text-xs text-slate-500 leading-snug">
          Select an agent in the tree first.
        </p>
      )}
      <ul className="list-none m-0 p-0 space-y-1.5">
        <li>
          <button
            type="button"
            className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-slate-300 bg-white text-slate-800 font-mono text-sm cursor-grab hover:border-blue-400 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed active:cursor-grabbing transition-colors"
            onClick={() => onAdd("claude-code")}
            disabled={disabled || !selectedAgentName}
          >
            Claude Code
            <span className="block text-xs text-slate-500 font-sans mt-0.5">
              Claude Code CLI session agent
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-slate-300 bg-white text-slate-800 font-mono text-sm cursor-grab hover:border-purple-400 hover:bg-purple-50 disabled:opacity-40 disabled:cursor-not-allowed active:cursor-grabbing transition-colors"
            onClick={() => onAdd("codex")}
            disabled={disabled || !selectedAgentName}
          >
            Codex
            <span className="block text-xs text-slate-500 font-sans mt-0.5">
              Codex CLI session agent
            </span>
          </button>
        </li>
      </ul>
    </section>
  );
}
