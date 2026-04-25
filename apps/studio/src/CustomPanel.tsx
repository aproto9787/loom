import { useCallback, useEffect, useState } from "react";
import type { HookDefinition, HookEvent, SkillDefinition } from "@loom/core";
import { useRunStore, type DiscoveredResource } from "./store.js";

const SERVER_ORIGIN =
  (import.meta.env?.VITE_LOOM_SERVER as string | undefined) ?? "http://localhost:8787";

const inputLight =
  "px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-900 text-sm font-mono placeholder:text-slate-400 focus:outline-none focus:border-blue-400 transition-colors";

const selectLight = `${inputLight} appearance-auto`;

type ResourceType = "mcp" | "hook" | "skill";
type Platform = "claude" | "codex";

const TYPE_ICONS: Record<ResourceType, string> = { mcp: "⚙", hook: "⚡", skill: "✦" };
const TYPE_COLORS: Record<ResourceType, string> = {
  mcp: "bg-blue-50 text-blue-700 border-blue-200",
  hook: "bg-amber-50 text-amber-700 border-amber-200",
  skill: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

/* ── Draft types ──────────────────────────────────────────────── */

interface HookDraft { type: "hook"; name: string; event: HookEvent; command: string; description: string }
interface SkillDraft { type: "skill"; name: string; prompt: string; description: string }
interface McpDraft { type: "mcp"; name: string; description: string }
type Draft = HookDraft | SkillDraft | McpDraft;

function emptyDraft(type: ResourceType): Draft {
  if (type === "hook") return { type: "hook", name: "", event: "on_complete", command: "", description: "" };
  if (type === "skill") return { type: "skill", name: "", prompt: "", description: "" };
  return { type: "mcp", name: "", description: "" };
}

function draftFromDiscovered(res: DiscoveredResource): Draft {
  if (res.type === "hook") return { type: "hook", name: res.name, event: (res.event as HookEvent) ?? "on_complete", command: res.command ?? "", description: "" };
  if (res.type === "skill") return { type: "skill", name: res.name, prompt: res.prompt ?? "", description: "" };
  return { type: "mcp", name: res.name, description: "" };
}

/* ── Main Custom Panel ────────────────────────────────────────── */

export function CustomPanel() {
  const discoveredResources = useRunStore((s) => s.discoveredResources);
  const providers = useRunStore((s) => s.providers);
  const discoverResources = useRunStore((s) => s.discoverResources);
  const hooks = useRunStore((s) => s.hooks);
  const skills = useRunStore((s) => s.skills);
  const fetchHooks = useRunStore((s) => s.fetchHooks);
  const fetchSkills = useRunStore((s) => s.fetchSkills);
  const saveHook = useRunStore((s) => s.saveHook);
  const saveSkill = useRunStore((s) => s.saveSkill);
  const deleteHook = useRunStore((s) => s.deleteHook);
  const deleteSkill = useRunStore((s) => s.deleteSkill);

  const [platform, setPlatform] = useState<Platform>("claude");
  const [draft, setDraft] = useState<Draft>(emptyDraft("hook"));
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [discovering, setDiscovering] = useState(false);

  useEffect(() => {
    fetchHooks(SERVER_ORIGIN);
    fetchSkills(SERVER_ORIGIN);
  }, [fetchHooks, fetchSkills]);

  const filteredDiscovered = discoveredResources.filter((r) => r.platform === platform);

  const savedResources = [
    ...hooks.map((h) => ({ type: "hook" as const, name: h.name, data: h })),
    ...skills.map((s) => ({ type: "skill" as const, name: s.name, data: s })),
  ];

  const handleDiscover = useCallback(async () => {
    setDiscovering(true);
    await discoverResources(SERVER_ORIGIN);
    setDiscovering(false);
  }, [discoverResources]);

  const handleNew = useCallback((type: ResourceType) => {
    setDraft(emptyDraft(type));
    setSelectedName(null);
    setError(undefined);
  }, []);

  const handleSelectDiscovered = useCallback((res: DiscoveredResource) => {
    setDraft(draftFromDiscovered(res));
    setSelectedName(res.name);
    setError(undefined);
  }, []);

  const handleSelectSaved = useCallback((item: { type: ResourceType; data: HookDefinition | SkillDefinition }) => {
    if (item.type === "hook") {
      const h = item.data as HookDefinition;
      setDraft({ type: "hook", name: h.name, event: h.event, command: h.command, description: h.description ?? "" });
    } else {
      const s = item.data as SkillDefinition;
      setDraft({ type: "skill", name: s.name, prompt: s.prompt, description: s.description ?? "" });
    }
    setSelectedName(item.data.name);
    setError(undefined);
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft.name.trim()) { setError("Name is required."); return; }
    setSaving(true);
    setError(undefined);
    try {
      if (draft.type === "hook") {
        if (!draft.command.trim()) { setError("Command is required."); setSaving(false); return; }
        await saveHook(SERVER_ORIGIN, { name: draft.name.trim(), event: draft.event, command: draft.command.trim(), description: draft.description.trim() || undefined });
      } else if (draft.type === "skill") {
        if (!draft.prompt.trim()) { setError("Prompt is required."); setSaving(false); return; }
        await saveSkill(SERVER_ORIGIN, { name: draft.name.trim(), prompt: draft.prompt.trim(), description: draft.description.trim() || undefined });
      }
      setSelectedName(draft.name.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [draft, saveHook, saveSkill]);

  const handleDelete = useCallback(async () => {
    if (!selectedName) return;
    const fileName = selectedName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      if (draft.type === "hook") await deleteHook(SERVER_ORIGIN, fileName);
      else if (draft.type === "skill") await deleteSkill(SERVER_ORIGIN, fileName);
      setDraft(emptyDraft(draft.type));
      setSelectedName(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }, [selectedName, draft.type, deleteHook, deleteSkill]);

  // Group discovered by type
  const groupedDiscovered: Record<ResourceType, DiscoveredResource[]> = { mcp: [], hook: [], skill: [] };
  for (const r of filteredDiscovered) groupedDiscovered[r.type].push(r);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] flex-1 min-h-0">
      {/* Sidebar */}
      <aside className="bg-slate-50 border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col overflow-y-auto">
        {/* Platform tabs */}
        <div className="flex border-b border-slate-200 shrink-0">
          {(["claude", "codex"] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`flex-1 px-4 py-2.5 text-sm font-medium capitalize border-b-2 transition-colors ${
                platform === p
                  ? "text-slate-900 border-blue-500"
                  : "text-slate-500 border-transparent hover:text-slate-700"
              }`}
              onClick={() => setPlatform(p)}
            >
              {p === "claude" ? "Claude Code" : "Codex"}
            </button>
          ))}
        </div>

        <div className="p-4 flex flex-col gap-3">
          {providers.length > 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="m-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Detected providers
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {providers.map((provider) => (
                  <div key={provider.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-700">{provider.displayName}</span>
                    <span className={`rounded-full px-2 py-0.5 font-semibold ${
                      provider.authState === "ready"
                        ? "bg-emerald-50 text-emerald-700"
                        : provider.authState === "missing"
                          ? "bg-red-50 text-red-700"
                          : "bg-amber-50 text-amber-700"
                    }`}>
                      {provider.authState}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Actions */}
          <div className="flex gap-1.5">
            <button
              type="button"
              className="flex-1 px-2 py-1.5 rounded-lg text-xs font-medium text-blue-600 hover:bg-blue-50 border border-slate-300 transition-colors"
              onClick={handleDiscover}
              disabled={discovering}
            >
              {discovering ? "Scanning..." : "↻ Discover"}
            </button>
            <button
              type="button"
              className="px-2 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 border border-slate-300 transition-colors"
              onClick={() => handleNew("hook")}
            >
              + Hook
            </button>
            <button
              type="button"
              className="px-2 py-1.5 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 border border-slate-300 transition-colors"
              onClick={() => handleNew("skill")}
            >
              + Skill
            </button>
          </div>

          {/* Discovered resources grouped by type */}
          {filteredDiscovered.length > 0 ? (
            <>
              {(["mcp", "hook", "skill"] as const).map((t) => {
                const items = groupedDiscovered[t];
                if (items.length === 0) return null;
                return (
                  <div key={t} className="flex flex-col gap-0.5">
                    <p className="m-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 mt-1">
                      {TYPE_ICONS[t]} {t}s ({items.length})
                    </p>
                    {items.map((res) => (
                      <button
                        key={`${res.type}-${res.name}`}
                        type="button"
                        className={`w-full px-3 py-1.5 rounded-lg text-left text-xs font-mono border transition-colors truncate ${
                          selectedName === res.name
                            ? "bg-slate-900 text-white border-transparent"
                            : "bg-white text-slate-800 border-slate-300 hover:border-slate-400"
                        }`}
                        onClick={() => handleSelectDiscovered(res)}
                        title={res.name}
                      >
                        {res.name}
                      </button>
                    ))}
                  </div>
                );
              })}
            </>
          ) : (
            <p className="text-xs text-slate-500 italic mt-2">
              Click Discover to scan {platform === "claude" ? "Claude Code" : "Codex"} config.
            </p>
          )}

          {/* Saved custom resources */}
          {savedResources.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <p className="m-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 mt-2">
                Custom (saved)
              </p>
              {savedResources.map((item) => (
                <button
                  key={`saved-${item.name}`}
                  type="button"
                  className={`w-full px-3 py-1.5 rounded-lg text-left text-xs font-mono border transition-colors ${
                    selectedName === item.name
                      ? "bg-slate-900 text-white border-transparent"
                      : "bg-white text-slate-800 border-slate-300 hover:border-slate-400"
                  }`}
                  onClick={() => handleSelectSaved(item)}
                >
                  {TYPE_ICONS[item.type]} {item.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Editor */}
      <main className="p-6 overflow-y-auto">
        <div className="flex items-center gap-3 mb-6">
          <h2 className="m-0 text-xl font-semibold text-slate-900">
            {selectedName ? "Edit Template" : "New Template"}
          </h2>
          <span className={`px-2 py-0.5 rounded-lg text-xs font-mono border ${TYPE_COLORS[draft.type]}`}>
            {draft.type}
          </span>
        </div>
        <div className="flex flex-col gap-4 max-w-xl">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Type</span>
            <select
              className={selectLight}
              value={draft.type}
              onChange={(e) => {
                setDraft(emptyDraft(e.target.value as ResourceType));
                setSelectedName(null);
              }}
            >
              <option value="mcp">MCP Server</option>
              <option value="hook">Hook</option>
              <option value="skill">Skill</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Name</span>
            <input
              type="text"
              className={inputLight}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder={draft.type === "hook" ? "e.g. notify-slack" : draft.type === "skill" ? "e.g. code-review" : "e.g. figma"}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Description</span>
            <input
              type="text"
              className={inputLight}
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="Optional description"
            />
          </label>

          {draft.type === "hook" && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Event</span>
                <select className={selectLight} value={draft.event} onChange={(e) => setDraft((d) => ({ ...d, event: e.target.value as HookEvent }))}>
                  <option value="on_start">on_start</option>
                  <option value="on_complete">on_complete</option>
                  <option value="on_error">on_error</option>
                  <option value="on_delegate">on_delegate</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Command</span>
                <input type="text" className={inputLight} value={draft.command} onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))} placeholder="e.g. bash /path/to/hook.sh" />
              </label>
            </>
          )}

          {draft.type === "skill" && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Prompt</span>
              <textarea
                className={`${inputLight} resize-y min-h-[120px] leading-relaxed`}
                value={draft.prompt}
                onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
                placeholder="Reusable prompt fragment..."
                rows={5}
              />
            </label>
          )}

          {draft.type === "mcp" && (
            <p className="m-0 text-xs text-slate-500 italic">MCP servers are auto-discovered. Use Discover to refresh.</p>
          )}

          {error && <p className="m-0 px-3 py-2 rounded-lg bg-red-50 text-red-600 text-sm">{error}</p>}

          {draft.type !== "mcp" && (
            <div className="flex gap-3 pt-1">
              <button type="button" className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-40 transition-colors" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
              {selectedName && (
                <button type="button" className="px-4 py-2 rounded-lg border border-red-300 text-red-600 text-sm font-medium hover:bg-red-50 transition-colors" onClick={handleDelete}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
