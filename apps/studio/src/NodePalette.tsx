import { EDITABLE_NODE_TYPES, type EditableNodeType } from "./store.js";

const NODE_DESCRIPTIONS: Partial<Record<EditableNodeType, string>> = {
  "agent.claude": "Anthropic API 스트리밍",
  "agent.litellm": "OpenAI/Gemini/Ollama 등 LiteLLM 프록시",
  "agent.claude-code": "Claude Code CLI 세션",
  "agent.codex": "Codex CLI 세션",
  "router.code": "JS 표현식으로 분기",
  "router.llm": "AI 분류기로 분기",
  "control.loop": "반복 실행 (while/for-each)",
  "control.parallel": "병렬 분기",
  "control.join": "병렬 결과 수집",
  "memory.memento": "장기 기억 (remember/recall)",
  "mcp.server": "MCP 서버 도구 제공",
  "io.input": "실행 시작 입력",
  "io.output": "최종 결과 출력",
  "io.file": "파일 읽기/쓰기",
};

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
                    {NODE_DESCRIPTIONS[type] ? (
                      <span className="node-palette__desc">{NODE_DESCRIPTIONS[type]}</span>
                    ) : null}
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
