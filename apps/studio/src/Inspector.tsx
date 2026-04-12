import { useEffect, useState } from "react";
import type { AgentConfig } from "@loom/core";
import { useRunStore, getAgentAtPath } from "./store.js";

function AgentEditor({
  agent,
  path,
}: {
  agent: AgentConfig;
  path: string[];
}) {
  const updateAgent = useRunStore((state) => state.updateAgent);
  const removeAgent = useRunStore((state) => state.removeAgent);
  const selectAgent = useRunStore((state) => state.selectAgent);
  const saveError = useRunStore((state) => state.saveError);

  const [name, setName] = useState(agent.name);
  const [type, setType] = useState(agent.type);
  const [repo, setRepo] = useState(agent.repo ?? "");
  const [system, setSystem] = useState(agent.system ?? "");

  useEffect(() => {
    setName(agent.name);
    setType(agent.type);
    setRepo(agent.repo ?? "");
    setSystem(agent.system ?? "");
  }, [agent.name, agent.type, agent.repo, agent.system]);

  const isRoot = path.length <= 1;

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== agent.name) {
      updateAgent(path, { name: trimmed });
    } else if (!trimmed) {
      setName(agent.name);
    }
  };

  return (
    <div className="inspector__body">
      <label className="inspector__field">
        <span>Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>

      <label className="inspector__field">
        <span>Type</span>
        <select
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

      <label className="inspector__field">
        <span>Repo (working directory)</span>
        <input
          type="text"
          value={repo}
          placeholder="e.g. ./my-project"
          onChange={(e) => {
            setRepo(e.target.value);
            updateAgent(path, {
              repo: e.target.value.trim() || undefined,
            });
          }}
        />
      </label>

      <label className="inspector__field">
        <span>System prompt</span>
        <textarea
          rows={4}
          value={system}
          onChange={(e) => {
            setSystem(e.target.value);
            updateAgent(path, {
              system: e.target.value.trim() || undefined,
            });
          }}
        />
      </label>

      {agent.agents && agent.agents.length > 0 ? (
        <div className="inspector__field">
          <span>Sub-agents ({agent.agents.length})</span>
          <ul className="inspector__sub-agents">
            {agent.agents.map((child) => (
              <li key={child.name}>
                <button
                  type="button"
                  className="inspector__sub-agent-link"
                  onClick={() => selectAgent([...path, child.name])}
                >
                  {child.name}
                  <code>{child.type}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {saveError ? <p className="inspector__error">{saveError}</p> : null}

      {!isRoot ? (
        <button
          type="button"
          className="inspector__delete"
          onClick={() => removeAgent(path)}
        >
          Delete agent
        </button>
      ) : null}
    </div>
  );
}

export function Inspector() {
  const flowDraft = useRunStore((state) => state.flowDraft);
  const selectedAgentPath = useRunStore((state) => state.selectedAgentPath);

  const selectedAgent =
    flowDraft && selectedAgentPath.length > 0
      ? getAgentAtPath(flowDraft.orchestrator, selectedAgentPath)
      : undefined;

  return (
    <section className="inspector">
      <p className="eyebrow">Inspector</p>
      {selectedAgent ? (
        <AgentEditor
          agent={selectedAgent}
          path={selectedAgentPath}
          key={selectedAgentPath.join("/")}
        />
      ) : (
        <p className="inspector__empty">
          Select an agent in the tree to edit its configuration.
        </p>
      )}
    </section>
  );
}
