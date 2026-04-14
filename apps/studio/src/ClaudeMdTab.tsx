import { useEffect, useState } from "react";
import { ClaudeMdLibraryPanel } from "./ClaudeMdLibraryPanel.js";
import { inputDark } from "./panelStyles.js";
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
    <div className="flex flex-col gap-4 p-5">
      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
        <span>Flow CLAUDE.md</span>
        <textarea
          className={inputDark}
          value={claudeMd}
          placeholder="Flow-wide Claude instructions (applied to every agent)"
          rows={10}
          onChange={(event) => {
            const next = event.target.value;
            setClaudeMd(next);
            updateFlowDraft({ claudeMd: next.trim() || undefined });
          }}
        />
      </label>
      <ClaudeMdLibraryPanel />
    </div>
  );
}
