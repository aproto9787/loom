import type { AgentType } from "@loom/core";

interface AgentPaletteProps {
  onAdd: (type: AgentType) => void;
  disabled?: boolean;
  selectedAgentName?: string;
}

export function NodePalette({ onAdd, disabled, selectedAgentName }: AgentPaletteProps) {
  return (
    <section className="node-palette">
      <p className="eyebrow">Add agent</p>
      {selectedAgentName ? (
        <p className="node-palette__hint">
          Add a sub-agent under <strong>{selectedAgentName}</strong>
        </p>
      ) : (
        <p className="node-palette__hint">Select an agent in the tree first.</p>
      )}
      <ul className="node-palette__list">
        <li>
          <button
            type="button"
            className="node-palette__item"
            onClick={() => onAdd("claude-code")}
            disabled={disabled || !selectedAgentName}
          >
            Claude Code
            <span className="node-palette__desc">Claude Code CLI session agent</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="node-palette__item"
            onClick={() => onAdd("codex")}
            disabled={disabled || !selectedAgentName}
          >
            Codex
            <span className="node-palette__desc">Codex CLI session agent</span>
          </button>
        </li>
      </ul>
    </section>
  );
}
