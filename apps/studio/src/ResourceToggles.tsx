import type { AgentConfig } from "@aproto9787/loom-core";

export function ResourceToggles({
  agent,
  groups,
  onToggle,
}: {
  agent: AgentConfig;
  groups: Array<{ field: "mcps" | "hooks" | "skills"; label: string; options: string[] }>;
  onToggle: (field: "mcps" | "hooks" | "skills", value: string) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {groups.map((group) => (
        <div key={group.field} className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {group.label}
          </span>
          {group.options.length === 0 ? (
            <span className="text-xs text-slate-500">No discovered {group.label.toLowerCase()}.</span>
          ) : (
            <div className="flex flex-col gap-2 max-h-40 overflow-y-auto pr-1 dark-scroll">
              {group.options.map((option) => {
                const checked = (agent[group.field] ?? []).includes(option);
                return (
                  <label key={option} className="flex items-start gap-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 rounded border-slate-600 bg-slate-800"
                      checked={checked}
                      onChange={() => onToggle(group.field, option)}
                    />
                    <span className="break-all font-mono">{option}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
