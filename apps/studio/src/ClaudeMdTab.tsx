import { useEffect, useState } from "react";
import { ClaudeMdLibraryPanel } from "./ClaudeMdLibraryPanel.js";
import { darkCard, darkCardMuted, inputDark } from "./panelStyles.js";
import { useRunStore } from "./store.js";

export default function ClaudeMdTab() {
  const flowDraft = useRunStore((state) => state.flowDraft);
  const updateFlowDraft = useRunStore((state) => state.updateFlowDraft);
  const [claudeMd, setClaudeMd] = useState(flowDraft?.claudeMd ?? "");

  useEffect(() => {
    setClaudeMd(flowDraft?.claudeMd ?? "");
  }, [flowDraft?.claudeMd]);

  if (!flowDraft) {
    return (
      <div className="flex flex-col gap-4 p-5">
        <p className="m-0 rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-6 text-sm text-slate-400">
          Load a flow to manage flow-level CLAUDE.md instructions.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-5">
      <section className={`flex flex-col gap-3 p-5 ${darkCard}`}>
        <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <span>Flow-wide CLAUDE.md (applied to every agent)</span>
          <textarea
            className={`${inputDark} min-h-[220px]`}
            value={claudeMd}
            placeholder="Flow-wide Claude instructions (applied to every agent)"
            rows={10}
            onChange={(event) => {
              setClaudeMd(event.target.value);
            }}
            onBlur={(event) => {
              const next = event.target.value;
              setClaudeMd(next);
              updateFlowDraft({ claudeMd: next.trim() || undefined });
            }}
          />
        </label>
      </section>
      <section className={`p-5 ${darkCardMuted}`}>
        <div className="mb-4">
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Library</p>
          <p className="m-0 mt-1 text-sm text-slate-500">
            Reusable CLAUDE.md snippets for agent-level selection.
          </p>
        </div>
        <ClaudeMdLibraryPanel />
      </section>
    </div>
  );
}
