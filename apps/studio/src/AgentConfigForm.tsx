import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentConfig } from "@loom/core";
import { SERVER_ORIGIN } from "./chat-run.js";
import { ResourceToggles } from "./ChatResourceToggles.js";
import { inputDark, selectDark } from "./chatPanelStyles.js";
import { useRunStore, type DiscoveredResource } from "./store.js";

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getDiscoveredNames(resources: DiscoveredResource[], type: DiscoveredResource["type"]): string[] {
  return resources.filter((resource) => resource.type === type).map((resource) => resource.name);
}

export function AgentConfigForm({
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
  const availableMcps = useRunStore((s) => s.availableMcps);
  const discoveredResources = useRunStore((s) => s.discoveredResources);
  const fetchMcps = useRunStore((s) => s.fetchMcps);
  const discoverResources = useRunStore((s) => s.discoverResources);

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

  useEffect(() => {
    fetchMcps(SERVER_ORIGIN);
    discoverResources(SERVER_ORIGIN);
  }, [discoverResources, fetchMcps]);

  const mcpOptions = useMemo(
    () => uniqueSorted([...availableMcps, ...getDiscoveredNames(discoveredResources, "mcp")]),
    [availableMcps, discoveredResources],
  );
  const hookOptions = useMemo(
    () => uniqueSorted(getDiscoveredNames(discoveredResources, "hook")),
    [discoveredResources],
  );
  const skillOptions = useMemo(
    () => uniqueSorted(getDiscoveredNames(discoveredResources, "skill")),
    [discoveredResources],
  );

  const toggleResource = useCallback(
    (field: "mcps" | "hooks" | "skills", value: string) => {
      const current = agent[field] ?? [];
      const next = current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value];
      updateAgent(path, { [field]: next.length > 0 ? next : undefined });
    },
    [agent, path, updateAgent],
  );

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
          <ResourceToggles
            agent={agent}
            groups={[
              { field: "mcps", label: "MCPs", options: mcpOptions },
              { field: "hooks", label: "Hooks", options: hookOptions },
              { field: "skills", label: "Skills", options: skillOptions },
            ]}
            onToggle={toggleResource}
          />
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
