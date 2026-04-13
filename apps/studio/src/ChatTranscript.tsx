import type { RunStreamEvent } from "./store.js";

type ChatEntry = { kind: "user"; content: string } | RunStreamEvent;

function isAgentFailure(
  entry: RunStreamEvent,
): entry is Extract<RunStreamEvent, { kind: "agent_error" | "agent_timeout" }> {
  return entry.kind === "agent_error" || entry.kind === "agent_timeout";
}

export function ChatBubble({ entry }: { entry: ChatEntry }) {
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
      return <div className="px-3 py-2 rounded-lg bg-amber-500/15 text-amber-300 text-sm">{entry.agentName}: aborted</div>;
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
      return <div className="px-3 py-2 rounded-lg bg-amber-500/15 text-amber-300 text-sm">Run aborted</div>;
    case "run_error":
      return <div className="px-3 py-2 rounded-lg bg-red-500/15 text-red-400 text-sm">Error: {entry.message}</div>;
    default:
      return null;
  }
}

export function StreamingBlock({ name, content }: { name: string; content: string }) {
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

export function countAgentFailures(entries: ChatEntry[]): number {
  return entries.filter(
    (entry): entry is Extract<RunStreamEvent, { kind: "agent_error" | "agent_timeout" }> =>
      entry.kind !== "user" && isAgentFailure(entry),
  ).length;
}

export type { ChatEntry };
