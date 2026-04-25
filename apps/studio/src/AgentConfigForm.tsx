import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentConfig, DelegationRule, RoleDefinition } from "@loom/core";
import { SERVER_ORIGIN } from "./sse-run.js";
import { darkButtonLink, darkCardMuted, inputDark, selectDark } from "./panelStyles.js";
import { getAgentAtPath, useRunStore, type DiscoveredResource } from "./store.js";

function toTabId(tab: "flowMd" | "delegation"): AgentConfigTab {
  return tab === "flowMd" ? "flow-md" : "delegation";
}

type ResourceField = "mcps" | "hooks" | "skills";
type AgentConfigTab = "basic" | "flow-md" | "delegation" | "resources";

const TAB_ORDER: Array<{ id: AgentConfigTab; label: string }> = [
  { id: "basic", label: "Basic" },
  { id: "flow-md", label: "flow.md" },
  { id: "delegation", label: "Delegation" },
  { id: "resources", label: "Resources" },
];

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getDiscoveredNames(
  resources: DiscoveredResource[],
  type: DiscoveredResource["type"],
  platform?: DiscoveredResource["platform"],
): string[] {
  return resources
    .filter((resource) => resource.type === type && (!platform || resource.platform === platform))
    .map((resource) => resource.name);
}

function buildRoleHint(role: RoleDefinition | undefined, field: "type" | "system"): string {
  if (!role) {
    return "";
  }

  switch (field) {
    case "type":
      return `Role default: ${role.type}`;
    case "system":
      return role.system ? `Role default: ${role.system}` : "";
  }
}

function collectRelatedAgentNames(root: AgentConfig, path: string[]): string[] {
  const currentName = path[path.length - 1];
  const siblingPath = path.slice(0, -1);
  const siblingParent = getAgentAtPath(root, siblingPath);
  const siblings = (siblingParent?.agents ?? []).map((entry) => entry.name);
  const current = getAgentAtPath(root, path);
  const children = (current?.agents ?? []).map((entry) => entry.name);
  return uniqueSorted([...siblings, ...children].filter((name) => name !== currentName));
}

export function DelegationRowEditor({
  rules,
  options,
  onChange,
}: {
  rules: DelegationRule[];
  options: string[];
  onChange: (rules: DelegationRule[] | undefined) => void;
}) {
  const emit = useCallback(
    (nextRules: DelegationRule[]) => {
      onChange(nextRules.length > 0 ? nextRules : undefined);
    },
    [onChange],
  );

  const updateRule = useCallback(
    (index: number, field: keyof DelegationRule, value: string) => {
      const nextRules = rules.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, [field]: value } : rule,
      );
      emit(nextRules);
    },
    [emit, rules],
  );

  const removeRule = useCallback(
    (index: number) => {
      emit(rules.filter((_, ruleIndex) => ruleIndex !== index));
    },
    [emit, rules],
  );

  const addRule = useCallback(() => {
    if (options.length === 0) {
      return;
    }
    const fallback = options.find((option) => !rules.some((rule) => rule.to === option)) ?? options[0];
    emit([...rules, { to: fallback, when: "" }]);
  }, [emit, options, rules]);

  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-5 text-sm text-slate-500">
          Add explicit delegation rules instead of editing raw YAML syntax.
        </div>
      ) : (
        rules.map((rule, index) => (
          <div
            key={`${rule.to}-${index}`}
            className="grid gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3"
          >
            <div className="grid gap-2 md:grid-cols-[160px_1fr_auto] md:items-start">
              <select
                className={selectDark}
                value={rule.to}
                onChange={(e) => updateRule(index, "to", e.target.value)}
              >
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className={inputDark}
                value={rule.when}
                placeholder="When should this agent receive the task?"
                onChange={(e) => updateRule(index, "when", e.target.value)}
              />
              <button
                type="button"
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/20"
                onClick={() => removeRule(index)}
              >
                Remove
              </button>
            </div>
          </div>
        ))
      )}
      <button
        type="button"
        className="self-start rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-semibold text-blue-200 transition-colors hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={addRule}
        disabled={options.length === 0}
      >
        + Add rule
      </button>
      {options.length === 0 ? (
        <p className="m-0 text-[11px] leading-4 text-amber-300">
          Add sibling or child agents before configuring delegation targets.
        </p>
      ) : null}
    </div>
  );
}

function ResourceSectionCard({
  field,
  label,
  options,
  selected,
  search,
  onSearch,
  onToggle,
}: {
  field: ResourceField;
  label: string;
  options: string[];
  selected: string[];
  search: string;
  onSearch: (next: string) => void;
  onToggle: (field: ResourceField, value: string) => void;
}) {
  const lowered = search.trim().toLowerCase();
  const filtered = options.filter((option) => option.toLowerCase().includes(lowered));
  const pinned = filtered.filter((option) => selected.includes(option));
  const available = filtered.filter((option) => !selected.includes(option));

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex flex-col gap-3 border-b border-slate-800 pb-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">{label}</p>
          <p className="m-0 mt-1 text-xs text-slate-500">
            {selected.length} selected / {options.length} available
          </p>
        </div>
        <input
          type="search"
          className={`${inputDark} w-full md:w-60`}
          value={search}
          placeholder={`Filter ${label.toLowerCase()}...`}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 px-4 py-5 text-sm text-slate-500">
          No matching {label.toLowerCase()}.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-300">
              Selected
            </span>
            {pinned.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 px-4 py-3 text-xs text-slate-500">
                Nothing pinned in {label.toLowerCase()} yet.
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {pinned.map((option) => (
                  <label
                    key={option}
                    className="flex items-start gap-3 rounded-xl border border-blue-500/40 bg-blue-500/10 px-3 py-3 text-sm text-slate-100 transition-colors hover:border-blue-400 hover:bg-blue-500/15"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-500 bg-slate-900 accent-blue-400"
                      checked
                      onChange={() => onToggle(field, option)}
                    />
                    <span className="break-all font-mono text-xs leading-5">{option}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Available
            </span>
            {available.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 px-4 py-3 text-xs text-slate-500">
                Everything matching this filter is already selected.
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {available.map((option) => (
                  <label
                    key={option}
                    className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-3 text-sm text-slate-300 opacity-75 transition-all hover:border-slate-600 hover:bg-slate-900/80 hover:opacity-100"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-500 bg-slate-900 accent-blue-400"
                      checked={false}
                      onChange={() => onToggle(field, option)}
                    />
                    <span className="break-all font-mono text-xs leading-5">{option}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
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
  const flowDraft = useRunStore((s) => s.flowDraft);
  const updateAgent = useRunStore((s) => s.updateAgent);
  const removeAgent = useRunStore((s) => s.removeAgent);
  const roles = useRunStore((s) => s.roles);
  const availableMcps = useRunStore((s) => s.availableMcps);
  const discoveredResources = useRunStore((s) => s.discoveredResources);
  const providers = useRunStore((s) => s.providers);
  const fetchMcps = useRunStore((s) => s.fetchMcps);
  const discoverResources = useRunStore((s) => s.discoverResources);

  const [name, setName] = useState(agent.name);
  const [type, setType] = useState(agent.type);
  const [model, setModel] = useState(agent.model ?? "");
  const [effort, setEffort] = useState(agent.effort ?? "");
  const [teamId, setTeamId] = useState(agent.team?.[0]?.id ?? "");
  const [flowMdRef, setFlowMdRef] = useState(agent.flowMdRef ?? "none");
  const [activeTab, setActiveTab] = useState<AgentConfigTab>("basic");
  const setStudioTab = useRunStore((s) => s.setActiveTab);
  const [resourceSearch, setResourceSearch] = useState<Record<ResourceField, string>>({
    mcps: "",
    hooks: "",
    skills: "",
  });

  useEffect(() => {
    setName(agent.name);
    setType(agent.type);
    setModel(agent.model ?? "");
    setEffort(agent.effort ?? "");
    setTeamId(agent.team?.[0]?.id ?? "");
    setFlowMdRef(agent.flowMdRef ?? "none");
    setActiveTab("basic");
    setResourceSearch({ mcps: "", hooks: "", skills: "" });
  }, [agent.name, agent.type, agent.model, agent.effort, agent.team, agent.flowMdRef, agent.delegation]);

  const role = useMemo(() => roles.find((entry) => entry.name === agent.role), [agent.role, roles]);

  const effectiveType = agent.type ?? role?.type ?? type;
  const modelOptions =
    effectiveType === "claude-code"
      ? ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]
      : ["gpt-5.5", "gpt-5.5-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark"];

  useEffect(() => {
    fetchMcps(SERVER_ORIGIN);
    discoverResources(SERVER_ORIGIN);
  }, [discoverResources, fetchMcps]);

  const resourcePlatform: DiscoveredResource["platform"] = effectiveType === "codex" ? "codex" : "claude";
  const mcpOptions = useMemo(
    () => {
      // availableMcps comes from /mcps (Claude-only) — skip it for Codex agents
      const base = resourcePlatform === "claude" ? availableMcps : [];
      return uniqueSorted([...base, ...getDiscoveredNames(discoveredResources, "mcp", resourcePlatform)]);
    },
    [availableMcps, discoveredResources, resourcePlatform],
  );
  const hookOptions = useMemo(
    () => uniqueSorted(getDiscoveredNames(discoveredResources, "hook", resourcePlatform)),
    [discoveredResources, resourcePlatform],
  );
  const skillOptions = useMemo(
    () => uniqueSorted(getDiscoveredNames(discoveredResources, "skill", resourcePlatform)),
    [discoveredResources, resourcePlatform],
  );

  const relatedAgentOptions = useMemo(() => {
    if (!flowDraft) {
      return [];
    }
    return collectRelatedAgentNames(flowDraft.orchestrator, path);
  }, [flowDraft, path]);

  const libraryEntries = useMemo(() => Object.entries(flowDraft?.flowMdLibrary ?? {}), [flowDraft?.flowMdLibrary]);
  const hasFlowMdSelection = flowMdRef !== "none";
  const delegationRules = agent.delegation ?? [];
  const isRoot = path.length <= 1;
  const runtimeMode = agent.runtime?.mode ?? (isRoot ? "host" : "isolated");
  const applyResources = agent.runtime?.applyResources ?? (isRoot ? "prompt-only" : "scoped-home");
  const delegationTransport = agent.runtime?.delegationTransport ?? (isRoot ? "mcp" : "bash");
  const providerOptions = providers.filter((provider) => provider.kind === effectiveType);

  const toggleResource = useCallback(
    (field: ResourceField, value: string) => {
      const current = agent[field] ?? [];
      const next = current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value];
      updateAgent(path, { [field]: next.length > 0 ? next : undefined });
    },
    [agent, path, updateAgent],
  );

  const updateRuntime = useCallback(
    (runtime: NonNullable<AgentConfig["runtime"]>) => {
      updateAgent(path, {
        runtime: {
          ...(agent.runtime ?? {}),
          ...runtime,
        },
      });
    },
    [agent.runtime, path, updateAgent],
  );

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
        <div className="px-4 pb-4 flex flex-col gap-4">
          <nav className="flex flex-wrap gap-2 pt-1">
            {TAB_ORDER
              // Leader (root orchestrator) runs in the host's real HOME with
              // the user's full Claude Code setup — flow-scoped MCP/hooks/skills
              // are not applied to it. Hide the Resources tab so it doesn't
              // mislead the user into thinking their toggles have effect.
              .filter((tab) => !(isRoot && tab.id === "resources"))
              .map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    activeTab === tab.id
                      ? "border-blue-400 bg-blue-500/20 text-blue-100"
                      : "border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-500 hover:text-slate-200"
                  }`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
          </nav>

          {activeTab === "basic" ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <span>Name</span>
                <input
                  type="text"
                  className={inputDark}
                  value={name}
                  onChange={(e) => {
                    const next = e.target.value;
                    setName(next);
                    const trimmed = next.trim();
                    if (trimmed) {
                      updateAgent(path, { name: trimmed });
                    }
                  }}
                  onBlur={() => {
                    const trimmed = name.trim();
                    if (trimmed) {
                      setName(trimmed);
                      updateAgent(path, { name: trimmed });
                    } else {
                      setName(agent.name);
                    }
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
                  title={buildRoleHint(role, "type") || undefined}
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
              {!isRoot ? (
                <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>Enabled</span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-blue-500"
                    checked={agent.enabled !== false}
                    onChange={(e) => updateAgent(path, { enabled: e.target.checked ? undefined : false })}
                  />
                </label>
              ) : null}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>Runtime Mode</span>
                  <select
                    className={selectDark}
                    value={runtimeMode}
                    onChange={(e) => updateRuntime({ mode: e.target.value as NonNullable<AgentConfig["runtime"]>["mode"] })}
                  >
                    <option value="host">host</option>
                    <option value="isolated">isolated</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>Resources</span>
                  <select
                    className={selectDark}
                    value={applyResources}
                    onChange={(e) => updateRuntime({ applyResources: e.target.value as NonNullable<AgentConfig["runtime"]>["applyResources"] })}
                  >
                    <option value="prompt-only">prompt-only</option>
                    <option value="scoped-home">scoped-home</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>Provider Profile</span>
                  <select
                    className={selectDark}
                    value={agent.runtime?.profile ?? ""}
                    onChange={(e) => updateRuntime({ profile: e.target.value || undefined })}
                  >
                    <option value="">Default profile</option>
                    {providerOptions.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName} ({provider.authState})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>Delegation Transport</span>
                  <select
                    className={selectDark}
                    value={delegationTransport}
                    onChange={(e) => updateRuntime({ delegationTransport: e.target.value as NonNullable<AgentConfig["runtime"]>["delegationTransport"] })}
                  >
                    <option value="mcp">mcp</option>
                    <option value="bash">bash</option>
                  </select>
                </label>
              </div>
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <span>Model</span>
                <select
                  className={selectDark}
                  value={model}
                  title={role?.model ? `Role default: ${role.model}` : undefined}
                  onChange={(e) => {
                    const val = e.target.value;
                    setModel(val);
                    updateAgent(path, { model: val || undefined });
                  }}
                  onBlur={() => updateAgent(path, { model: model || undefined })}
                >
                  <option value="">Default</option>
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              {roles.length > 0 && (
                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>Role</span>
                  <select
                    className={selectDark}
                    value={agent.role ?? ""}
                    title={role?.system ? `Role system: ${role.system}` : undefined}
                    onChange={(e) => {
                      const value = e.target.value || undefined;
                      const nextRole = roles.find((entry) => entry.name === value);
                      setType(agent.type ?? nextRole?.type ?? "claude-code");
                      setModel(agent.model ?? "");
                      setEffort(agent.effort ?? "");
                      updateAgent(path, { role: value });
                    }}
                    onBlur={(e) => updateAgent(path, { role: e.target.value || undefined })}
                  >
                    <option value="">No role</option>
                    {roles.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                        {r.description ? ` — ${r.description}` : ""}
                      </option>
                    ))}
                  </select>
                  {role ? (
                    <div className="text-[10px] font-normal normal-case tracking-normal text-slate-500">
                      <div>Type default: {role.type}</div>
                      {role.model ? <div>Model default: {role.model}</div> : null}
                      {role.effort ? <div>Effort default: {role.effort}</div> : null}
                    </div>
                  ) : null}
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <span>Effort</span>
                <select
                  className={selectDark}
                  value={effort}
                  title={role?.effort ? `Role default: ${role.effort}` : undefined}
                  onChange={(e) => {
                    const val = e.target.value;
                    setEffort(val);
                    updateAgent(path, { effort: (val || undefined) as AgentConfig["effort"] });
                  }}
                  onBlur={() => updateAgent(path, { effort: (effort || undefined) as AgentConfig["effort"] })}
                >
                  <option value="">Default</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
                {!agent.effort && role?.effort && (
                  <span className="text-[10px] font-normal normal-case tracking-normal text-slate-500">
                    Role default: {role.effort}
                  </span>
                )}
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <span>Team</span>
                <input
                  type="text"
                  className={inputDark}
                  value={teamId}
                  placeholder="Optional team id"
                  onChange={(e) => {
                    const value = e.target.value;
                    setTeamId(value);
                    updateAgent(path, {
                      team: value.trim() ? [{ id: value.trim() }] : undefined,
                    });
                  }}
                  onBlur={() => {
                    const trimmed = teamId.trim();
                    setTeamId(trimmed);
                    updateAgent(path, {
                      team: trimmed ? [{ id: trimmed }] : undefined,
                    });
                  }}
                />
              </label>
              {role?.system && !agent.system && (
                <p className="m-0 text-[10px] leading-4 text-slate-500">
                  Role system: {role.system}
                </p>
              )}
            </div>
          ) : null}

          {activeTab === "flow-md" ? (
            <div className={`flex flex-col gap-3 p-4 ${darkCardMuted}`}>
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <span>flow.md Ref</span>
                <select
                  className={selectDark}
                  value={flowMdRef}
                  onChange={(e) => {
                    const value = e.target.value;
                    setFlowMdRef(value);
                    updateAgent(path, { flowMdRef: value === "none" ? undefined : value });
                  }}
                >
                  <option value="none">none</option>
                  {libraryEntries.map(([key]) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </label>
              <p className="m-0 text-xs leading-5 text-slate-500">
                Pick a library entry here, then manage its content in the global flow.md tab.
              </p>
              <button
                type="button"
                className={`${darkButtonLink} self-start`}
                onClick={() => {
                  setStudioTab("flowMd");
                  setActiveTab(toTabId("flowMd"));
                }}
              >
                {hasFlowMdSelection ? "Open selected entry in flow.md tab" : "Open flow.md tab"}
              </button>
            </div>
          ) : null}

          {activeTab === "delegation" ? (
            <div className={`flex flex-col gap-3 p-4 ${darkCardMuted}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="m-0 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Delegation Rules
                  </p>
                  <p className="m-0 mt-1 text-xs leading-5 text-slate-500">
                    Delegation is configured in the global Delegation tab.
                  </p>
                </div>
                <button
                  type="button"
                  className={darkButtonLink}
                  onClick={() => {
                    setStudioTab("delegation");
                    setActiveTab(toTabId("delegation"));
                  }}
                >
                  Edit in Delegation tab
                </button>
              </div>
              {delegationRules.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-5 text-sm text-slate-500">
                  No rules - add them in the Delegation tab.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {delegationRules.map((rule, index) => (
                    <article
                      key={`${rule.to}-${rule.when}-${index}`}
                      className="rounded-xl border border-slate-700 bg-slate-900/70 p-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-200">
                          {rule.to}
                        </span>
                        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                          Rule {index + 1}
                        </span>
                      </div>
                      <p className="m-0 mt-3 text-sm leading-6 text-slate-200">{rule.when}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {activeTab === "resources" && !isRoot ? (
            <div className="flex flex-col gap-4">
              <ResourceSectionCard
                field="mcps"
                label="MCPs"
                options={mcpOptions}
                selected={agent.mcps ?? []}
                search={resourceSearch.mcps}
                onSearch={(next) => setResourceSearch((state) => ({ ...state, mcps: next }))}
                onToggle={toggleResource}
              />
              <ResourceSectionCard
                field="hooks"
                label="Hooks"
                options={hookOptions}
                selected={agent.hooks ?? []}
                search={resourceSearch.hooks}
                onSearch={(next) => setResourceSearch((state) => ({ ...state, hooks: next }))}
                onToggle={toggleResource}
              />
              <ResourceSectionCard
                field="skills"
                label="Skills"
                options={skillOptions}
                selected={agent.skills ?? []}
                search={resourceSearch.skills}
                onSearch={(next) => setResourceSearch((state) => ({ ...state, skills: next }))}
                onToggle={toggleResource}
              />
            </div>
          ) : null}

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
