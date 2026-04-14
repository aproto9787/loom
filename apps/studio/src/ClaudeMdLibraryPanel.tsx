import { useEffect, useMemo, useState } from "react";
import { darkButton, darkCardMuted, inputDark } from "./panelStyles.js";
import { useRunStore } from "./store.js";

function sanitizeKey(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}

export function ClaudeMdLibraryPanel() {
  const flowDraft = useRunStore((s) => s.flowDraft);
  const updateFlowDraft = useRunStore((s) => s.updateFlowDraft);

  const library = flowDraft?.claudeMdLibrary ?? {};
  const entries = useMemo(() => Object.entries(library), [library]);
  const [selectedKey, setSelectedKey] = useState<string | null>(entries[0]?.[0] ?? null);
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");

  useEffect(() => {
    if (entries.length === 0) {
      setSelectedKey(null);
      setDraftKey("");
      setDraftValue("");
      return;
    }

    const nextKey = selectedKey && library[selectedKey] !== undefined ? selectedKey : entries[0][0];
    setSelectedKey(nextKey);
    setDraftKey(nextKey);
    setDraftValue(library[nextKey] ?? "");
  }, [entries, library, selectedKey]);

  const commitLibrary = (nextLibrary: Record<string, string>) => {
    updateFlowDraft({ claudeMdLibrary: Object.keys(nextLibrary).length > 0 ? nextLibrary : undefined });
  };

  const handleSelect = (key: string) => {
    setSelectedKey(key);
    setDraftKey(key);
    setDraftValue(library[key] ?? "");
  };

  const handleAdd = () => {
    let counter = entries.length + 1;
    let nextKey = `entry-${counter}`;
    while (library[nextKey] !== undefined) {
      counter += 1;
      nextKey = `entry-${counter}`;
    }
    const nextLibrary = { ...library, [nextKey]: "" };
    commitLibrary(nextLibrary);
    setSelectedKey(nextKey);
    setDraftKey(nextKey);
    setDraftValue("");
  };

  const handleRenameBlur = () => {
    if (!selectedKey) {
      return;
    }
    const nextKey = sanitizeKey(draftKey);
    if (!nextKey) {
      setDraftKey(selectedKey);
      return;
    }
    if (nextKey === selectedKey) {
      return;
    }
    if (library[nextKey] !== undefined) {
      setDraftKey(selectedKey);
      return;
    }
    const nextLibrary = Object.fromEntries(
      Object.entries(library).map(([key, value]) => (key === selectedKey ? [nextKey, value] : [key, value])),
    );
    commitLibrary(nextLibrary);
    setSelectedKey(nextKey);
    setDraftKey(nextKey);
  };

  const handleContentBlur = () => {
    if (!selectedKey) {
      return;
    }
    commitLibrary({
      ...library,
      [selectedKey]: draftValue,
    });
  };

  const handleDelete = () => {
    if (!selectedKey) {
      return;
    }
    const nextEntries = entries.filter(([key]) => key !== selectedKey);
    const nextLibrary = Object.fromEntries(nextEntries);
    commitLibrary(nextLibrary);
    const fallbackKey = nextEntries[0]?.[0] ?? null;
    setSelectedKey(fallbackKey);
    setDraftKey(fallbackKey ?? "");
    setDraftValue(fallbackKey ? nextLibrary[fallbackKey] ?? "" : "");
  };

  return (
    <section className={`flex flex-col gap-4 p-4 ${darkCardMuted}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
            CLAUDE.md Library
          </p>
          <p className="m-0 mt-1 text-xs leading-5 text-slate-500">
            Reusable prompt snippets that agents can reference by key.
          </p>
        </div>
        <button
          type="button"
          className={darkButton}
          onClick={handleAdd}
        >
          + Add entry
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {entries.length === 0 ? (
          <span className="rounded-full border border-dashed border-slate-700 px-3 py-2 text-xs text-slate-500">
            No library entries yet.
          </span>
        ) : (
          entries.map(([key]) => (
            <button
              key={key}
              type="button"
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                selectedKey === key
                  ? "border-blue-400 bg-blue-500/20 text-blue-100"
                  : "border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-500 hover:text-slate-200"
              }`}
              onClick={() => handleSelect(key)}
            >
              {key}
            </button>
          ))
        )}
      </div>

      {selectedKey ? (
        <div className="grid gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>Entry Key</span>
            <input
              type="text"
              className={inputDark}
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              onBlur={handleRenameBlur}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>Content</span>
            <textarea
              className={inputDark}
              value={draftValue}
              rows={12}
              placeholder="Reusable CLAUDE.md snippet"
              onChange={(e) => setDraftValue(e.target.value)}
              onBlur={handleContentBlur}
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/20"
              onClick={handleDelete}
            >
              Delete entry
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
