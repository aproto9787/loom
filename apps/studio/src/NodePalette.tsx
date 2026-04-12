import { EDITABLE_NODE_TYPES, type EditableNodeType } from "./store.js";

interface NodePaletteProps {
  onAdd: (type: EditableNodeType) => void;
  disabled?: boolean;
}

const PALETTE_GROUPS: Array<{ label: string; types: EditableNodeType[] }> = [
  { label: "io", types: ["io.input", "io.output", "io.file"] },
  { label: "router", types: ["router.code", "router.llm"] },
  { label: "agent", types: ["agent.claude", "agent.litellm", "agent.claude-code", "agent.codex"] },
  { label: "control", types: ["control.loop", "control.parallel", "control.join"] },
  { label: "memory", types: ["memory.memento"] },
  { label: "mcp", types: ["mcp.server"] },
];

function handleDragStart(type: EditableNodeType, event: React.DragEvent<HTMLButtonElement>) {
  event.dataTransfer.setData("application/loom-node-type", type);
  event.dataTransfer.effectAllowed = "copy";
}

export function NodePalette({ onAdd, disabled }: NodePaletteProps) {
  return (
    <section className="node-palette">
      <p className="eyebrow">Palette</p>
      {PALETTE_GROUPS.map((group) => {
        const groupTypes = group.types.filter((type) => EDITABLE_NODE_TYPES.includes(type));
        if (groupTypes.length === 0) return null;
        return (
          <div className="node-palette__group" key={group.label}>
            <p className="node-palette__group-label">{group.label}</p>
            <ul>
              {groupTypes.map((type) => (
                <li key={type}>
                  <button
                    type="button"
                    className="node-palette__item"
                    draggable={!disabled}
                    onDragStart={(event) => handleDragStart(type, event)}
                    onClick={() => {
                      if (!disabled) onAdd(type);
                    }}
                    disabled={disabled}
                  >
                    {type}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p className="node-palette__hint">Drag onto the canvas or click to add at origin.</p>
    </section>
  );
}
