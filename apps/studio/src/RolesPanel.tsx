import { useCallback, useEffect, useState } from "react";
import type { RoleDefinition } from "@aproto9787/heddle-core";
import { darkButton, darkCardMuted, inputDark, selectDark } from "./panelStyles.js";
import { useRunStore } from "./store.js";

const SERVER_ORIGIN =
  (import.meta.env?.VITE_HEDDLE_SERVER as string | undefined) ?? "http://localhost:8787";

function emptyRole(): RoleDefinition {
  return { name: "", type: "claude-code", system: "" };
}

export function RolesPanel() {
  const roles = useRunStore((s) => s.roles);
  const fetchRoles = useRunStore((s) => s.fetchRoles);
  const saveRole = useRunStore((s) => s.saveRole);
  const deleteRole = useRunStore((s) => s.deleteRole);
  const [selected, setSelected] = useState<RoleDefinition | null>(null);
  const [draft, setDraft] = useState<RoleDefinition>(emptyRole());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchRoles(SERVER_ORIGIN);
  }, [fetchRoles]);

  const handleSelect = useCallback((role: RoleDefinition) => {
    setSelected(role);
    setDraft({ ...role });
    setError(undefined);
  }, []);

  const handleNew = useCallback(() => {
    setSelected(null);
    setDraft(emptyRole());
    setError(undefined);
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft.name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await saveRole(SERVER_ORIGIN, {
        ...draft,
        name: draft.name.trim(),
        system: draft.system.trim(),
        description: draft.description?.trim() || undefined,
        effort: draft.effort || undefined,
        mcps: (draft.mcps ?? []).length > 0 ? draft.mcps : undefined,
      });
      setSelected({ ...draft });
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [draft, saveRole]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    const fileName = selected.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    try {
      await deleteRole(SERVER_ORIGIN, fileName);
      setSelected(null);
      setDraft(emptyRole());
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }, [selected, deleteRole]);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 bg-slate-950 p-5 lg:grid-cols-[280px_1fr]">
      <aside className={`flex flex-col overflow-y-auto p-5 ${darkCardMuted}`}>
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              Roles
            </p>
            <p className="m-0 mt-1 text-sm text-slate-500">Saved role presets for agent creation.</p>
          </div>
          <button type="button" className={darkButton} onClick={handleNew}>
            + New
          </button>
        </div>
        <ul className="m-0 list-none space-y-2 p-0">
          {roles.length === 0 ? (
            <li className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-5 text-sm text-slate-500">
              No roles yet.
            </li>
          ) : (
            roles.map((role) => (
              <li key={role.name}>
                <button
                  type="button"
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                    selected?.name === role.name
                      ? "border-blue-500/40 bg-blue-500/10 text-slate-100"
                      : "border-slate-700 bg-slate-900/70 text-slate-200 hover:border-slate-500 hover:bg-slate-900"
                  }`}
                  onClick={() => handleSelect(role)}
                >
                  <span className="block font-mono text-sm font-semibold">{role.name}</span>
                  <span
                    className={`block font-mono text-xs ${
                      selected?.name === role.name ? "text-blue-200" : "text-slate-500"
                    }`}
                  >
                    {role.type}
                  </span>
                  {role.description && (
                    <span
                      className={`mt-1 block text-xs leading-snug ${
                        selected?.name === role.name ? "text-slate-300" : "text-slate-400"
                      }`}
                    >
                      {role.description}
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>
      <main className={`overflow-y-auto p-5 ${darkCardMuted}`}>
        <div className="max-w-xl">
          <h2 className="m-0 mb-2 text-xl font-semibold text-slate-100">
            {selected ? "Edit Role" : "New Role"}
          </h2>
          <p className="m-0 mb-6 text-sm text-slate-500">
            Define reusable system prompts and defaults for new agents.
          </p>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Name
              </span>
              <input
                type="text"
                className={inputDark}
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="e.g. backend-dev"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Type
              </span>
              <select
                className={selectDark}
                value={draft.type}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    type: e.target.value as RoleDefinition["type"],
                  }))
                }
              >
                <option value="claude-code">claude-code</option>
                <option value="codex">codex</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Description
              </span>
              <input
                type="text"
                className={inputDark}
                value={draft.description ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="One-line description"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                System
              </span>
              <textarea
                className={`${inputDark} min-h-[140px]`}
                value={draft.system}
                onChange={(e) => setDraft((d) => ({ ...d, system: e.target.value }))}
                placeholder="Role system prompt"
                rows={5}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Effort
              </span>
              <select
                className={selectDark}
                value={draft.effort ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, effort: (e.target.value || undefined) as RoleDefinition["effort"] }))}
              >
                <option value="">Default</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            </label>

            {error && (
              <p className="m-0 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {error}
              </p>
            )}
            <div className="flex gap-3 pt-1">
              <button type="button" className={darkButton} onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
              {selected && (
                <button
                  type="button"
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20"
                  onClick={handleDelete}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
