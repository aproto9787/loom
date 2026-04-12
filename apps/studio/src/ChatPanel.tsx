import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentConfig, RoleDefinition } from "@loom/core";
import { useRunStore, getAgentAtPath, type RunStreamEvent } from "./store.js";
import { useSseRun } from "./useSseRun.js";

/* ── Shared dark-mode input classes ───────────────────────────── */

const inputDark =
  "px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-slate-100 text-sm font-mono placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition-colors";

const selectDark = `${inputDark} appearance-auto`;

/* ── Agent config header ──────────────────────────────────────── */

export function AgentSummary({
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
  const roles = useRunStore((s) => s.roles);

  const [name, setName] = useState(agent.name);
  const [type, setType] = useState(agent.type);
  const [model, setModel] = useState(agent.model ?? "");
  const [effort, setEffort] = useState(agent.effort ?? "");

  useEffect(() => {
    setName(agent.name);
    setType(agent.type);
    setModel(agent.model ?? "");
    setEffort(agent.effort ?? "");
  }, [agent.name, agent.type, agent.model, agent.effort]);

  const modelOptions =
    type === "claude-code"
      ? ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]
      : ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark"];

  const isRoot = path.length <= 1;

  return (
    <div className="border-b border-slate-800">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-3 bg-transparent text-slate-100 text-sm text-left hover:bg-white/[0.04] transition-colors border-0"
        onClick={onToggle}
      >
        <span className="font-semibold font-mono">{agent.name}</span>
        <span className="font-mono text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300">
          {agent.type}
        </span>
        <span className="ml-auto text-xs text-slate-400">
          {expanded ? "\u25be" : "\u25b8"}
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>Name</span>
            <input
              type="text"
              className={inputDark}
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
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>Type</span>
            <select
              className={selectDark}
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
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>Model</span>
            <select
              className={selectDark}
              value={model}
              onChange={(e) => {
                const val = e.target.value;
                setModel(val);
                updateAgent(path, { model: val || undefined });
              }}
            >
              <option value="">Default</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          {roles.length > 0 && (
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <span>Import from Role</span>
              <select
                className={selectDark}
                value=""
                onChange={(e) => {
                  const role = roles.find((r) => r.name === e.target.value);
                  if (!role) return;
                  setName(role.name);
                  setType(role.type);
                  setModel(role.model ?? "");
                  setEffort(role.effort ?? "");
                  updateAgent(path, {
                    name: role.name,
                    type: role.type,
                    model: role.model,
                    system: role.system,
                    effort: role.effort,
                  });
                }}
              >
                <option value="" disabled>
                  Select a role...
                </option>
                {roles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                    {r.description ? ` — ${r.description}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>Effort</span>
            <select
              className={selectDark}
              value={effort}
              onChange={(e) => {
                const val = e.target.value;
                setEffort(val);
                updateAgent(path, { effort: (val || undefined) as AgentConfig["effort"] });
              }}
            >
              <option value="">Default</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          {!isRoot && (
            <button
              type="button"
              className="self-start px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-xs font-semibold hover:bg-red-500/20 transition-colors"
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

/* ── Chat bubble ──────────────────────────────────────────────── */

type ChatEntry = { kind: "user"; content: string } | RunStreamEvent;

function isAgentFailure(entry: RunStreamEvent): entry is Extract<RunStreamEvent, { kind: "agent_error" | "agent_timeout" }> {
  return entry.kind === "agent_error" || entry.kind === "agent_timeout";
}

function ChatBubble({ entry }: { entry: ChatEntry }) {
  if (entry.kind === "user") {
    return (
      <div className="self-end max-w-[88%] px-3 py-2 rounded-xl rounded-br-sm bg-blue-500/20 text-blue-100 text-sm font-mono">
        <pre className="m-0 whitespace-pre-wrap break-words font-[inherit] text-[inherit]">
          {entry.content}
        </pre>
      </div>
    );
  }
  switch (entry.kind) {
    case "agent_delegate":
      return (
        <div className="px-3 py-1 text-xs text-slate-400">
          <span className="mr-1 text-blue-400">&rarr;</span>
          Delegated to <strong>{entry.childAgent}</strong>
        </div>
      );
    case "agent_start":
      return (
        <div className="flex items-center gap-2 px-3 py-1 text-xs text-slate-400">
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-white/[0.08] text-[10px] font-bold tracking-wide">
            {entry.agentType === "claude-code" ? "CC" : "CX"}
          </span>
          {entry.agentName} started
        </div>
      );
    case "agent_complete":
      return (
        <div className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700">
          <div className="flex items-center gap-2 mb-1.5 text-xs text-slate-300">
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold">
              &check;
            </span>
            {entry.agentName}
          </div>
          <pre className="m-0 px-2 py-1.5 rounded-lg bg-black/30 text-sm text-slate-200 whitespace-pre-wrap break-words font-mono max-h-48 overflow-auto">
            {entry.output}
          </pre>
        </div>
      );
    case "agent_error":
      return (
        <div className="px-3 py-2 rounded-xl border border-red-500/30 bg-red-500/15 text-red-200 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-300">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500/20 text-xs">!</span>
            Agent Error
          </div>
          <div className="font-mono text-xs text-red-100/80">Worker {entry.agentName}</div>
          <div className="mt-1 whitespace-pre-wrap break-words font-mono text-sm">{entry.error}</div>
        </div>
      );
    case "agent_abort":
      return (
        <div className="px-3 py-2 rounded-lg bg-amber-500/15 text-amber-300 text-sm">
          {entry.agentName}: aborted
        </div>
      );
    case "agent_timeout":
      return (
        <div className="px-3 py-2 rounded-xl border border-red-500/30 bg-red-500/15 text-red-200 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-300">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500/20 text-xs">!</span>
            Agent Timeout
          </div>
          <div className="font-mono text-xs text-red-100/80">Worker {entry.agentName}</div>
          <div className="mt-1 whitespace-pre-wrap break-words font-mono text-sm">
            Timed out after {entry.timeoutMs}ms
          </div>
        </div>
      );
    case "run_complete":
      return (
        <div className="px-3 py-2 rounded-xl bg-white/[0.04] border border-slate-700">
          <p className="m-0 mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Final Output
          </p>
          <pre className="m-0 px-2 py-1.5 rounded-lg bg-black/30 text-sm text-slate-200 whitespace-pre-wrap break-words font-mono max-h-48 overflow-auto">
            {entry.output}
          </pre>
        </div>
      );
    case "run_aborted":
      return (
        <div className="px-3 py-2 rounded-lg bg-amber-500/15 text-amber-300 text-sm">
          Run aborted
        </div>
      );
    case "run_error":
      return (
        <div className="px-3 py-2 rounded-lg bg-red-500/15 text-red-400 text-sm">
          Error: {entry.message}
        </div>
      );
    default:
      return null;
  }
}

/* ── Streaming block ──────────────────────────────────────────── */

function StreamingBlock({ name, content }: { name: string; content: string }) {
  return (
    <div className="px-3 py-2 rounded-xl bg-white/[0.02] border border-blue-500/20">
      <div className="flex items-center gap-2 mb-1.5 text-xs text-slate-300">
        <span className="px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 text-[10px] font-bold animate-spin-slow">
          &loz;
        </span>
        {name}
      </div>
      <pre className="m-0 px-2 py-1.5 rounded-lg bg-black/30 text-sm text-slate-200 whitespace-pre-wrap break-words font-mono max-h-48 overflow-auto">
        {content}
      </pre>
    </div>
  );
}

/* ── Main panel ───────────────────────────────────────────────── */

export function ChatPanel({ hideAgentConfig }: { hideAgentConfig?: boolean } = {}) {
  const flowPath = useRunStore((s) => s.flowPath);
  const flowDraft = useRunStore((s) => s.flowDraft);
  const selectedAgentPath = useRunStore((s) => s.selectedAgentPath);
  const isStreaming = useRunStore((s) => s.isStreaming);
  const runId = useRunStore((s) => s.runId);
  const runError = useRunStore((s) => s.runError);
  const events = useRunStore((s) => s.events);
  const agentRuntimes = useRunStore((s) => s.agentRuntimes);
  const input = useRunStore((s) => s.chatInput);
  const setInput = useRunStore((s) => s.setChatInput);
  const autoRunAfterSave = useRunStore((s) => s.autoRunAfterSave);
  const setAutoRunAfterSave = useRunStore((s) => s.setAutoRunAfterSave);

  const { runFlow, abortFlow } = useSseRun();
  const [configExpanded, setConfigExpanded] = useState(false);
  const [abortError, setAbortError] = useState<string>();
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const processedRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const frameRef = useRef<number | null>(null);

  const selectedAgent =
    flowDraft && selectedAgentPath.length > 0
      ? getAgentAtPath(flowDraft.orchestrator, selectedAgentPath)
      : undefined;

  useEffect(() => {
    if (events.length < processedRef.current) {
      processedRef.current = 0;
    }
    if (events.length > processedRef.current) {
      const fresh = events.slice(processedRef.current);
      processedRef.current = events.length;
      const entries = fresh.filter(
        (e): e is RunStreamEvent => e.kind !== "agent_token" && e.kind !== "run_start",
      );
      if (entries.length > 0) {
        setChatLog((prev) => [...prev, ...entries]);
      }
    }
  }, [events]);

  const streamingAgents = useMemo(
    () =>
      Object.values(agentRuntimes)
        .filter((a) => a.state === "running" && a.tokens.length > 0)
        .map((agent) => ({
          name: agent.name,
          content: agent.tokens.join(""),
        })),
    [agentRuntimes],
  );

  const failureCount = useMemo(
    () => chatLog.filter((entry): entry is Extract<RunStreamEvent, { kind: "agent_error" | "agent_timeout" }> => entry.kind !== "user" && isAgentFailure(entry)).length,
    [chatLog],
  );

  const syncScroll = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    syncScroll();
  }, [chatLog, streamingAgents, syncScroll]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  const handleSend = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || isStreaming) return;
    setAbortError(undefined);
    setAutoRunAfterSave(false);
    setChatLog((prev) => [...prev, { kind: "user" as const, content: prompt }]);
    setInput("");
    await runFlow(flowPath, prompt);
  }, [input, isStreaming, flowPath, runFlow, setAutoRunAfterSave, setInput]);

  const handleAbort = useCallback(async () => {
    if (!runId || !isStreaming) return;
    try {
      setAbortError(undefined);
      await abortFlow(runId);
    } catch (error) {
      setAbortError(error instanceof Error ? error.message : String(error));
    }
  }, [abortFlow, isStreaming, runId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <section className="flex flex-col rounded-xl border border-slate-700 bg-slate-900 overflow-hidden min-h-0">
      {!hideAgentConfig &&
        (selectedAgent ? (
          <AgentSummary
            agent={selectedAgent}
            path={selectedAgentPath}
            expanded={configExpanded}
            onToggle={() => setConfigExpanded((v) => !v)}
            key={selectedAgentPath.join("/")}
          />
        ) : (
          <div className="border-b border-slate-800">
            <p className="m-0 px-4 py-3 text-sm text-slate-400 italic">
              Select an agent in the tree
            </p>
          </div>
        ))}

      <div
        className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5 min-h-0 dark-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {chatLog.length === 0 && streamingAgents.length === 0 && (
          <p className="m-auto text-sm text-slate-400 italic">Send a prompt to start a run.</p>
        )}
        {chatLog.map((entry, i) => (
          <ChatBubble key={i} entry={entry} />
        ))}
        {streamingAgents.map((a) => (
          <StreamingBlock key={`s-${a.name}`} name={a.name} content={a.content} />
        ))}
      </div>

      <div className="flex items-end gap-2 p-3 border-t border-slate-800 bg-black/20 shrink-0">
        <div className="flex-1 flex flex-col gap-2">
          {(abortError || runError) && (
            <div className="px-3 py-2 rounded-xl border border-red-500/30 bg-red-500/15 text-red-200 text-sm">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-300">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500/20 text-xs">!</span>
                Run Error
              </div>
              <div className="whitespace-pre-wrap break-words font-mono">{abortError ?? runError}</div>
            </div>
          )}
          {autoRunAfterSave && !isStreaming && (
            <div className="px-3 py-2 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-100 text-sm">
              Save the flow to start this prompt immediately.
            </div>
          )}
          {failureCount > 0 && !runError && (
            <div className="px-3 py-2 rounded-xl border border-red-500/20 bg-red-500/10 text-red-100 text-xs">
              {failureCount} worker issue{failureCount > 1 ? "s" : ""} captured in the transcript.
            </div>
          )}
          <textarea
          className="flex-1 px-3 py-2 rounded-lg border border-slate-600 bg-slate-800 text-slate-100 text-sm font-mono resize-none placeholder:text-slate-500 focus:outline-none focus:border-blue-500 disabled:opacity-40 transition-colors"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          placeholder="Enter a prompt..."
          rows={2}
        />
        </div>
        {isStreaming && runId ? (
          <button
            type="button"
            className="px-3 h-8 rounded-lg bg-red-500/20 text-red-300 text-xs font-semibold border border-red-500/30 shrink-0 hover:bg-red-500/30 disabled:opacity-40 transition-colors"
            onClick={handleAbort}
          >
            Abort
          </button>
        ) : null}
        <button
          type="button"
          className="w-8 h-8 rounded-lg bg-blue-500 text-white font-bold border-0 shrink-0 hover:bg-blue-600 disabled:opacity-40 transition-colors"
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
        >
          {isStreaming ? "\u00b7\u00b7\u00b7" : "\u2191"}
        </button>
      </div>
    </section>
  );
}
