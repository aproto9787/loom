import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentConfig } from "@loom/core";
import { useRunStore, getAgentAtPath, type RunStreamEvent } from "./store.js";
import { useSseRun } from "./useSseRun.js";

/* ── Agent config header ────────────────────────────────────── */

function AgentSummary({
  agent,
  path,
  expanded,
  onToggle,
}: {
  agent: AgentConfig;
  path: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const updateAgent = useRunStore((s) => s.updateAgent);
  const removeAgent = useRunStore((s) => s.removeAgent);

  const [name, setName] = useState(agent.name);
  const [type, setType] = useState(agent.type);
  const [system, setSystem] = useState(agent.system ?? "");

  useEffect(() => {
    setName(agent.name);
    setType(agent.type);
    setSystem(agent.system ?? "");
  }, [agent.name, agent.type, agent.system]);

  const isRoot = path.length <= 1;

  return (
    <div className="chat-agent">
      <button type="button" className="chat-agent__summary" onClick={onToggle}>
        <span className="chat-agent__name">{agent.name}</span>
        <span className="chat-agent__type">{agent.type}</span>
        <span className="chat-agent__chevron">{expanded ? "\u25be" : "\u25b8"}</span>
      </button>
      {expanded && (
        <div className="chat-agent__config">
          <label className="chat-agent__field">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                const trimmed = name.trim();
                if (trimmed && trimmed !== agent.name) updateAgent(path, { name: trimmed });
                else if (!trimmed) setName(agent.name);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>
          <label className="chat-agent__field">
            <span>Type</span>
            <select
              value={type}
              onChange={(e) => {
                const next = e.target.value as AgentConfig["type"];
                setType(next);
                updateAgent(path, { type: next });
              }}
            >
              <option value="claude-code">claude-code</option>
              <option value="codex">codex</option>
            </select>
          </label>
          <label className="chat-agent__field">
            <span>System</span>
            <textarea
              rows={3}
              value={system}
              onChange={(e) => {
                setSystem(e.target.value);
                updateAgent(path, { system: e.target.value.trim() || undefined });
              }}
            />
          </label>
          {!isRoot && (
            <button
              type="button"
              className="chat-agent__delete"
              onClick={() => removeAgent(path)}
            >
              Delete agent
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Chat bubble ────────────────────────────────────────────── */

type ChatEntry = { kind: "user"; content: string } | RunStreamEvent;

function ChatBubble({ entry }: { entry: ChatEntry }) {
  if (entry.kind === "user") {
    return (
      <div className="chat-bubble chat-bubble--user">
        <pre>{entry.content}</pre>
      </div>
    );
  }
  switch (entry.kind) {
    case "agent_delegate":
      return (
        <div className="chat-bubble chat-bubble--delegate">
          <span className="chat-bubble__icon">&rarr;</span>
          Delegated to <strong>{entry.childAgent}</strong>
        </div>
      );
    case "agent_start":
      return (
        <div className="chat-bubble chat-bubble--system">
          <span className="chat-bubble__badge">
            {entry.agentType === "claude-code" ? "CC" : "CX"}
          </span>
          {entry.agentName} started
        </div>
      );
    case "agent_complete":
      return (
        <div className="chat-bubble chat-bubble--complete">
          <div className="chat-bubble__head">
            <span className="chat-bubble__badge chat-bubble__badge--done">&check;</span>
            {entry.agentName}
          </div>
          <pre className="chat-bubble__output">{entry.output}</pre>
        </div>
      );
    case "agent_error":
      return (
        <div className="chat-bubble chat-bubble--error">
          {entry.agentName}: {entry.error}
        </div>
      );
    case "run_complete":
      return (
        <div className="chat-bubble chat-bubble--final">
          <div className="chat-bubble__label">Final Output</div>
          <pre className="chat-bubble__output">{entry.output}</pre>
        </div>
      );
    case "run_error":
      return (
        <div className="chat-bubble chat-bubble--error">
          Error: {entry.message}
        </div>
      );
    default:
      return null;
  }
}

/* ── Streaming block ────────────────────────────────────────── */

function StreamingBlock({ name, tokens }: { name: string; tokens: string[] }) {
  return (
    <div className="chat-bubble chat-bubble--streaming">
      <div className="chat-bubble__head">
        <span className="chat-bubble__badge chat-bubble__badge--running">&loz;</span>
        {name}
      </div>
      <pre className="chat-bubble__tokens">{tokens.join("")}</pre>
    </div>
  );
}

/* ── Main panel ─────────────────────────────────────────────── */

export function ChatPanel() {
  const flowPath = useRunStore((s) => s.flowPath);
  const flowDraft = useRunStore((s) => s.flowDraft);
  const selectedAgentPath = useRunStore((s) => s.selectedAgentPath);
  const isStreaming = useRunStore((s) => s.isStreaming);
  const events = useRunStore((s) => s.events);
  const agentRuntimes = useRunStore((s) => s.agentRuntimes);

  const { runFlow } = useSseRun();
  const [input, setInput] = useState("");
  const [configExpanded, setConfigExpanded] = useState(false);
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const processedRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectedAgent =
    flowDraft && selectedAgentPath.length > 0
      ? getAgentAtPath(flowDraft.orchestrator, selectedAgentPath)
      : undefined;

  // Sync store events into local chatLog (skip token & run_start events)
  useEffect(() => {
    if (events.length < processedRef.current) {
      processedRef.current = 0;
    }
    if (events.length > processedRef.current) {
      const fresh = events.slice(processedRef.current);
      processedRef.current = events.length;
      const entries = fresh.filter(
        (e): e is RunStreamEvent =>
          e.kind !== "agent_token" && e.kind !== "run_start",
      );
      if (entries.length > 0) {
        setChatLog((prev) => [...prev, ...entries]);
      }
    }
  }, [events]);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const streamingAgents = Object.values(agentRuntimes).filter(
    (a) => a.state === "running" && a.tokens.length > 0,
  );

  const handleSend = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || isStreaming) return;
    setChatLog((prev) => [...prev, { kind: "user" as const, content: prompt }]);
    setInput("");
    await runFlow(flowPath, prompt);
  }, [input, isStreaming, flowPath, runFlow]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <section className="chat-panel">
      {selectedAgent ? (
        <AgentSummary
          agent={selectedAgent}
          path={selectedAgentPath}
          expanded={configExpanded}
          onToggle={() => setConfigExpanded((v) => !v)}
          key={selectedAgentPath.join("/")}
        />
      ) : (
        <div className="chat-agent">
          <p className="chat-agent__empty">Select an agent in the tree</p>
        </div>
      )}

      <div className="chat-panel__messages" ref={scrollRef}>
        {chatLog.length === 0 && streamingAgents.length === 0 && (
          <p className="chat-panel__empty">Send a prompt to start a run.</p>
        )}
        {chatLog.map((entry, i) => (
          <ChatBubble key={i} entry={entry} />
        ))}
        {streamingAgents.map((a) => (
          <StreamingBlock key={`s-${a.name}`} name={a.name} tokens={a.tokens} />
        ))}
      </div>

      <div className="chat-panel__input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          placeholder="Enter a prompt..."
          rows={2}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
        >
          {isStreaming ? "\u00b7\u00b7\u00b7" : "\u2191"}
        </button>
      </div>
    </section>
  );
}
