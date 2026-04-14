import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentConfig, RoleDefinition } from "@loom/core";
import { SERVER_ORIGIN } from "./sse-run.js";
import { ResourceToggles } from "./ResourceToggles.js";
import { inputDark, selectDark } from "./panelStyles.js";
import { useRunStore, type DiscoveredResource } from "./store.js";

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getDiscoveredNames(resources: DiscoveredResource[], type: DiscoveredResource["type"]): string[] {
  return resources.filter((resource) => resource.type === type).map((resource) => resource.name);
}

function formatCapabilitiesHint(values: string[] | undefined): string {
  return values?.join(", ") ?? "";
}

function formatDelegation(value: AgentConfig["delegation"] | undefined): string {
  return (value ?? []).map((entry) => `${entry.to}: ${entry.when}`).join("\n");
}

function parseDelegation(value: string): NonNullable<AgentConfig["delegation"]> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) {
        return null;
      }
      const to = line.slice(0, separator).trim();
      const when = line.slice(separator + 1).trim();
      if (!to || !when) {
        return null;
      }
      return { to, when };
    })
    .filter((entry): entry is NonNullable<AgentConfig["delegation"]>[number] => entry !== null);
}

function formatIsolatedHint(value: boolean | undefined): string {
  if (value === undefined) {
    return "";
  }
  return value ? "Role default: enabled" : "Role default: disabled";
}

function buildRoleHint(role: RoleDefinition | undefined, field: "type" | "system" | "capabilities" | "isolated"): string {
  if (!role) {
    return "";
  }

  switch (field) {
    case "type":
      return `Role default: ${role.type}`;
    case "system":
      return role.system ? `Role default: ${role.system}` : "";
    case "capabilities":
      return formatCapabilitiesHint(role.capabilities);
    case "isolated":
      return formatIsolatedHint(role.isolated);
  }
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
  const [claudeMd, setClaudeMd] = useState(agent.claudeMd ?? "");
  const [delegation, setDelegation] = useState(formatDelegation(agent.delegation));

  useEffect(() => {
    setName(agent.name);
    setType(agent.type);
    setModel(agent.model ?? "");
    setEffort(agent.effort ?? "");
    setClaudeMd(agent.claudeMd ?? "");
    setDelegation(formatDelegation(agent.delegation));
  }, [agent.name, agent.type, agent.model, agent.effort, agent.claudeMd, agent.delegation]);

  const role = useMemo(() => roles.find((entry) => entry.name === agent.role), [agent.role, roles]);

  const effectiveType = agent.type ?? role?.type ?? type;
  const modelOptions =
    effectiveType === "claude-code"
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
            >
              <option value="">Default</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
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
                  {role.capabilities?.length ? <div>Capabilities default: {formatCapabilitiesHint(role.capabilities)}</div> : null}
                  {role.isolated !== undefined ? <div>{formatIsolatedHint(role.isolated)}</div> : null}
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
            >
              <option value="">Default</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            {!agent.effort && role?.effort && (
              <span className="text-[10px] font-normal normal-case tracking-normal text-slate-500">
                Role default: {role.effort}
              </span>
            )}
          </label>
          {role?.system && !agent.system && (
            <p className="m-0 text-[10px] leading-4 text-slate-500">
              Role system: {role.system}
            </p>
          )}
          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400" title={buildRoleHint(role, "isolated") || undefined}>
            <input
              type="checkbox"
              checked={agent.isolated ?? role?.isolated ?? false}
              onChange={(e) => updateAgent(path, { isolated: e.target.checked || undefined })}
            />
            <span>Isolated</span>
            {!agent.isolated && role?.isolated !== undefined && (
              <span className="text-[10px] font-normal normal-case tracking-normal text-slate-500">
                {buildRoleHint(role, "isolated")}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>CLAUDE.md</span>
            <textarea
              className={inputDark}
              value={claudeMd}
              placeholder="Optional per-agent Claude instructions"
              rows={5}
              onChange={(e) => setClaudeMd(e.target.value)}
              onBlur={() => {
                const next = claudeMd.trim();
                updateAgent(path, { claudeMd: next || undefined });
                setClaudeMd(next);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>Delegation</span>
            <textarea
              className={inputDark}
              value={delegation}
              placeholder={"child-agent: when to delegate\nreviewer: after implementation"}
              rows={4}
              onChange={(e) => setDelegation(e.target.value)}
              onBlur={() => {
                const next = parseDelegation(delegation);
                updateAgent(path, { delegation: next.length > 0 ? next : undefined });
                setDelegation(formatDelegation(next));
              }}
            />
            <span className="text-[10px] font-normal normal-case tracking-normal text-slate-500">
              One rule per line in the form <code>agent-name: condition</code>
            </span>
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
