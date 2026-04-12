import { useMemo, useState } from "react";
import { useRunStore, type AgentRuntime } from "./store.js";
import { useSseRun } from "./useSseRun.js";

function AgentCard({ agent }: { agent: AgentRuntime }) {
  const tokens = agent.tokens.join("");
  const typeLabel = agent.agentType === "claude-code" ? "CC" : agent.agentType === "codex" ? "CX" : "";

  return (
    <article
      className={`node-card node-card--${agent.state}`}
      style={{ marginLeft: `${agent.depth * 20}px` }}
    >
      <header>
        <span className="node-id">{agent.name}</span>
        {typeLabel ? <span className="node-type">{typeLabel}</span> : null}
        {agent.parentAgent ? (
          <span className="node-duration">via {agent.parentAgent}</span>
        ) : null}
        <span className={`node-state node-state--${agent.state}`}>{agent.state}</span>
      </header>
      {tokens ? <pre className="node-tokens">{tokens}</pre> : null}
      {agent.output !== undefined ? (
        <pre className="node-output">{agent.output}</pre>
      ) : null}
      {agent.error ? <p className="node-error">{agent.error}</p> : null}
    </article>
  );
}

export function RunPanel() {
  const flowPath = useRunStore((state) => state.flowPath);
  const isStreaming = useRunStore((state) => state.isStreaming);
  const flowName = useRunStore((state) => state.flowName);
  const runId = useRunStore((state) => state.runId);
  const agentRuntimes = useRunStore((state) => state.agentRuntimes);
  const finalOutput = useRunStore((state) => state.finalOutput);
  const runError = useRunStore((state) => state.runError);

  const { runFlow } = useSseRun();
  const [userPrompt, setUserPrompt] = useState("");

  const orderedAgents = useMemo(() => {
    const agents = Object.values(agentRuntimes);
    // Sort by order of appearance (insertion order from events)
    return agents;
  }, [agentRuntimes]);

  const handleRun = async () => {
    if (!userPrompt.trim()) return;
    await runFlow(flowPath, userPrompt);
  };

  return (
    <section className="run-panel">
      <header className="run-panel__header">
        <div>
          <p className="eyebrow">Run</p>
          <h2>{flowName ?? "No run yet"}</h2>
          {runId ? <code className="run-id">{runId}</code> : null}
        </div>
        <button type="button" onClick={handleRun} disabled={isStreaming || !userPrompt.trim()}>
          {isStreaming ? "Streaming..." : "Run"}
        </button>
      </header>

      <div className="run-panel__controls">
        <label>
          <span>Prompt</span>
          <textarea
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            rows={5}
            disabled={isStreaming}
            spellCheck={false}
            placeholder="Enter a prompt for the orchestrator..."
          />
        </label>
      </div>

      {runError ? <p className="run-error">{runError}</p> : null}

      <div className="run-panel__nodes">
        {orderedAgents.length === 0 ? (
          <p className="run-empty">Enter a prompt and press Run to stream agent events.</p>
        ) : (
          orderedAgents.map((agent) => (
            <AgentCard key={agent.name} agent={agent} />
          ))
        )}
      </div>

      {finalOutput ? (
        <div className="run-panel__outputs">
          <p className="eyebrow">Final output</p>
          <pre>{finalOutput}</pre>
        </div>
      ) : null}
    </section>
  );
}
