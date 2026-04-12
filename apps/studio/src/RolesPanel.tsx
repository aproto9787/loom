import { useCallback, useEffect, useState } from "react";
import type { RoleDefinition } from "@loom/core";
import { useRunStore } from "./store.js";

const SERVER_ORIGIN =
  (import.meta.env?.VITE_LOOM_SERVER as string | undefined) ?? "http://localhost:8787";

function emptyRole(): RoleDefinition {
  return { name: "", type: "claude-code", system: "" };
}

/* ── Shared light-mode input classes ──────────────────────────── */

const inputLight =
  "px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-900 text-sm font-mono placeholder:text-slate-400 focus:outline-none focus:border-blue-400 transition-colors";

const selectLight = `${inputLight} appearance-auto`;

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
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] flex-1 min-h-0">
      <aside className="p-6 bg-slate-50 border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <p className="m-0 text-xs font-semibold uppercase tracking-wider text-blue-600">
            Roles
          </p>
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg border border-blue-400/40 bg-blue-500/10 text-blue-600 text-xs font-semibold hover:bg-blue-500/20 transition-colors"
            onClick={handleNew}
          >
            + New
          </button>
        </div>
        <ul className="list-none m-0 p-0 space-y-1.5">
          {roles.length === 0 ? (
            <li className="text-sm text-slate-500 italic">No roles yet</li>
          ) : (
            roles.map((role) => (
              <li key={role.name}>
                <button
                  type="button"
                  className={`w-full px-3 py-2 rounded-lg text-left transition-colors border ${
                    selected?.name === role.name
                      ? "bg-slate-900 text-white border-transparent"
                      : "bg-white border-slate-300 text-slate-800 hover:border-slate-400"
                  }`}
                  onClick={() => handleSelect(role)}
                >
                  <span className="block font-semibold font-mono text-sm">{role.name}</span>
                  <span
                    className={`block font-mono text-xs ${
                      selected?.name === role.name ? "text-slate-400" : "text-slate-500"
                    }`}
                  >
                    {role.type}
                  </span>
                  {role.description && (
                    <span
                      className={`block text-xs leading-snug mt-0.5 ${
                        selected?.name === role.name ? "text-slate-400" : "text-slate-600"
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
      <main className="p-6 overflow-y-auto">
        <h2 className="m-0 mb-6 text-xl font-semibold text-slate-900">
          {selected ? "Edit Role" : "New Role"}
        </h2>
        <div className="flex flex-col gap-4 max-w-xl">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Name
            </span>
            <input
              type="text"
              className={inputLight}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="e.g. backend-dev"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Type
            </span>
            <select
              className={selectLight}
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
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Description
            </span>
            <input
              type="text"
              className={inputLight}
              value={draft.description ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="One-line description"
            />
          </label>

          {error && (
            <p className="m-0 px-3 py-2 rounded-lg bg-red-50 text-red-600 text-sm">{error}</p>
          )}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-40 transition-colors"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {selected && (
              <button
                type="button"
                className="px-4 py-2 rounded-lg border border-red-300 text-red-600 text-sm font-medium hover:bg-red-50 transition-colors"
                onClick={handleDelete}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
