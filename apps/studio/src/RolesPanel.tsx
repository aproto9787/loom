import { useCallback, useEffect, useState } from "react";
import type { RoleDefinition } from "@loom/core";
import { useRunStore } from "./store.js";

const SERVER_ORIGIN =
  (import.meta.env?.VITE_LOOM_SERVER as string | undefined) ?? "http://localhost:8787";

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
    if (!draft.name.trim() || !draft.system.trim()) {
      setError("Name and system prompt are required.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await saveRole(SERVER_ORIGIN, { ...draft, name: draft.name.trim(), system: draft.system.trim(), description: draft.description?.trim() || undefined });
      setSelected({ ...draft });
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [draft, saveRole]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    const fileName = selected.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      await deleteRole(SERVER_ORIGIN, fileName);
      setSelected(null);
      setDraft(emptyRole());
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }, [selected, deleteRole]);

  return (
    <div className="roles-view">
      <aside className="roles-sidebar">
        <div className="roles-sidebar__header">
          <p className="eyebrow">Roles</p>
          <button type="button" className="roles-sidebar__new" onClick={handleNew}>
            + New
          </button>
        </div>
        <ul className="roles-list">
          {roles.length === 0 ? (
            <li className="roles-list__empty">No roles yet</li>
          ) : (
            roles.map((role) => (
              <li key={role.name}>
                <button
                  type="button"
                  className={`roles-list__button${selected?.name === role.name ? " roles-list__button--active" : ""}`}
                  onClick={() => handleSelect(role)}
                >
                  <span className="roles-list__name">{role.name}</span>
                  <span className="roles-list__type">{role.type}</span>
                  {role.description && (
                    <span className="roles-list__desc">{role.description}</span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>
      <main className="roles-editor">
        <h2 className="roles-editor__title">
          {selected ? "Edit Role" : "New Role"}
        </h2>
        <div className="roles-editor__form">
          <label className="roles-editor__field">
            <span>Name</span>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="e.g. backend-dev"
            />
          </label>
          <label className="roles-editor__field">
            <span>Type</span>
            <select
              value={draft.type}
              onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as RoleDefinition["type"] }))}
            >
              <option value="claude-code">claude-code</option>
              <option value="codex">codex</option>
            </select>
          </label>
          <label className="roles-editor__field">
            <span>Description</span>
            <input
              type="text"
              value={draft.description ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="One-line description"
            />
          </label>
          <label className="roles-editor__field">
            <span>System Prompt</span>
            <textarea
              rows={12}
              value={draft.system}
              onChange={(e) => setDraft((d) => ({ ...d, system: e.target.value }))}
              placeholder="System prompt for the agent..."
            />
          </label>
          {error && <p className="roles-editor__error">{error}</p>}
          <div className="roles-editor__actions">
            <button
              type="button"
              className="roles-editor__save"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {selected && (
              <button
                type="button"
                className="roles-editor__delete"
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
