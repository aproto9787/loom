import { useEffect, useMemo, useState } from "react";
import type { FlowNode } from "@loom/core";
import { formatJson } from "./replay.js";
import { useRunStore } from "./store.js";

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function safeParseJson(value: string): { ok: true; parsed: unknown } | { ok: false; error: string } {
  if (!value.trim()) return { ok: true, parsed: {} };
  try {
    return { ok: true, parsed: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
  }
}

// --- Type-specific config editors ---

interface ConfigEditorProps {
  node: FlowNode;
  onUpdate: (patch: Partial<FlowNode>) => void;
}

function AgentCodeEditor({ node, onUpdate }: ConfigEditorProps) {
  const config = node.config as Record<string, unknown>;
  const [system, setSystem] = useState((config.system as string) ?? "");
  const [model, setModel] = useState((config.model as string) ?? "");

  useEffect(() => {
    setSystem((node.config.system as string) ?? "");
    setModel((node.config.model as string) ?? "");
  }, [node.id]);

  return (
    <>
      <label className="inspector__field">
        <span>system prompt</span>
        <textarea
          rows={4}
          value={system}
          onChange={(e) => {
            setSystem(e.target.value);
            onUpdate({ config: { ...node.config, system: e.target.value } });
          }}
        />
      </label>
      <label className="inspector__field">
        <span>model</span>
        <input
          type="text"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            onUpdate({ config: { ...node.config, model: e.target.value } });
          }}
        />
      </label>
    </>
  );
}

function RouterLlmEditor({ node, onUpdate }: ConfigEditorProps) {
  const config = node.config as Record<string, unknown>;
  const [system, setSystem] = useState((config.system as string) ?? "");
  const [model, setModel] = useState((config.model as string) ?? "");
  const [branchDraft, setBranchDraft] = useState(node.branches.join(", "));

  useEffect(() => {
    setSystem((node.config.system as string) ?? "");
    setModel((node.config.model as string) ?? "");
    setBranchDraft(node.branches.join(", "));
  }, [node.id]);

  return (
    <>
      <label className="inspector__field">
        <span>system (classifier prompt)</span>
        <textarea
          rows={4}
          value={system}
          onChange={(e) => {
            setSystem(e.target.value);
            onUpdate({ config: { ...node.config, system: e.target.value } });
          }}
        />
      </label>
      <label className="inspector__field">
        <span>model</span>
        <input
          type="text"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            onUpdate({ config: { ...node.config, model: e.target.value } });
          }}
        />
      </label>
      <label className="inspector__field">
        <span>branches (comma-separated)</span>
        <input
          type="text"
          value={branchDraft}
          placeholder="e.g. technical, creative, general"
          onChange={(e) => {
            setBranchDraft(e.target.value);
            const branches = e.target.value
              .split(",")
              .map((b) => b.trim())
              .filter(Boolean);
            onUpdate({ branches });
          }}
        />
      </label>
    </>
  );
}

function ControlLoopEditor({ node, onUpdate }: ConfigEditorProps) {
  const config = node.config as Record<string, unknown>;
  const [mode, setMode] = useState((config.mode as string) ?? "for-each");
  const [max, setMax] = useState((config.max as number) ?? 10);
  const [condition, setCondition] = useState((config.condition as string) ?? "");

  useEffect(() => {
    setMode((node.config.mode as string) ?? "for-each");
    setMax((node.config.max as number) ?? 10);
    setCondition((node.config.condition as string) ?? "");
  }, [node.id]);

  return (
    <>
      <label className="inspector__field">
        <span>mode</span>
        <select
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            onUpdate({ config: { ...node.config, mode: e.target.value } });
          }}
        >
          <option value="while">while</option>
          <option value="for-each">for-each</option>
        </select>
      </label>
      <label className="inspector__field">
        <span>max iterations</span>
        <input
          type="number"
          min={1}
          value={max}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 1;
            setMax(v);
            onUpdate({ config: { ...node.config, max: v } });
          }}
        />
      </label>
      {mode === "while" ? (
        <label className="inspector__field">
          <span>condition</span>
          <input
            type="text"
            value={condition}
            placeholder="e.g. result.done != true"
            onChange={(e) => {
              setCondition(e.target.value);
              onUpdate({ config: { ...node.config, condition: e.target.value } });
            }}
          />
        </label>
      ) : null}
    </>
  );
}

function ControlJoinEditor({ node, onUpdate }: ConfigEditorProps) {
  const config = node.config as Record<string, unknown>;
  const [mode, setMode] = useState((config.mode as string) ?? "all");

  useEffect(() => {
    setMode((node.config.mode as string) ?? "all");
  }, [node.id]);

  return (
    <label className="inspector__field">
      <span>mode</span>
      <select
        value={mode}
        onChange={(e) => {
          setMode(e.target.value);
          onUpdate({ config: { ...node.config, mode: e.target.value } });
        }}
      >
        <option value="all">all</option>
        <option value="any">any</option>
        <option value="race">race</option>
      </select>
    </label>
  );
}

function MemoryMementoEditor({ node, onUpdate }: ConfigEditorProps) {
  const config = node.config as Record<string, unknown>;
  const [operation, setOperation] = useState((config.operation as string) ?? "recall");

  useEffect(() => {
    setOperation((node.config.operation as string) ?? "recall");
  }, [node.id]);

  return (
    <label className="inspector__field">
      <span>operation</span>
      <select
        value={operation}
        onChange={(e) => {
          setOperation(e.target.value);
          onUpdate({ config: { ...node.config, operation: e.target.value } });
        }}
      >
        <option value="remember">remember</option>
        <option value="recall">recall</option>
        <option value="forget">forget</option>
      </select>
    </label>
  );
}

const TYPE_SPECIFIC_EDITORS: Record<string, React.FC<ConfigEditorProps>> = {
  "agent.claude-code": AgentCodeEditor,
  "agent.codex": AgentCodeEditor,
  "router.llm": RouterLlmEditor,
  "control.loop": ControlLoopEditor,
  "control.join": ControlJoinEditor,
  "memory.memento": MemoryMementoEditor,
};

// --- Main Inspector ---

interface InspectorProps {
  node: FlowNode;
}

function NodeEditor({ node }: InspectorProps) {
  const updateNode = useRunStore((state) => state.updateNode);
  const renameNode = useRunStore((state) => state.renameNode);
  const deleteNode = useRunStore((state) => state.deleteNode);
  const saveError = useRunStore((state) => state.saveError);

  const [idDraft, setIdDraft] = useState(node.id);
  const [configJson, setConfigJson] = useState(() => stringifyJson(node.config));
  const [inputsJson, setInputsJson] = useState(() => stringifyJson(node.inputs));
  const [whenValue, setWhenValue] = useState(node.when ?? "");
  const [configError, setConfigError] = useState<string | undefined>();
  const [inputsError, setInputsError] = useState<string | undefined>();

  useEffect(() => {
    setIdDraft(node.id);
    setConfigJson(stringifyJson(node.config));
    setInputsJson(stringifyJson(node.inputs));
    setWhenValue(node.when ?? "");
    setConfigError(undefined);
    setInputsError(undefined);
  }, [node.id]);

  const commitConfig = (value: string) => {
    setConfigJson(value);
    const result = safeParseJson(value);
    if (!result.ok) {
      setConfigError(result.error);
      return;
    }
    if (typeof result.parsed !== "object" || result.parsed === null || Array.isArray(result.parsed)) {
      setConfigError("config must be a JSON object");
      return;
    }
    setConfigError(undefined);
    updateNode(node.id, { config: result.parsed as Record<string, unknown> });
  };

  const commitInputs = (value: string) => {
    setInputsJson(value);
    const result = safeParseJson(value);
    if (!result.ok) {
      setInputsError(result.error);
      return;
    }
    if (typeof result.parsed !== "object" || result.parsed === null || Array.isArray(result.parsed)) {
      setInputsError("inputs must be a JSON object");
      return;
    }
    const parsedInputs = result.parsed as Record<string, unknown>;
    const normalized: FlowNode["inputs"] = {};
    for (const [key, value] of Object.entries(parsedInputs)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        setInputsError(`input "${key}" must be an object with a "from" string`);
        return;
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.from !== "string" || entry.from.length === 0) {
        setInputsError(`input "${key}" missing "from" string`);
        return;
      }
      normalized[key] = { from: entry.from, fallback: entry.fallback };
    }
    setInputsError(undefined);
    updateNode(node.id, { inputs: normalized });
  };

  const commitWhen = (value: string) => {
    setWhenValue(value);
    updateNode(node.id, { when: value.trim() || undefined });
  };

  const commitId = () => {
    if (idDraft !== node.id && idDraft.trim()) {
      renameNode(node.id, idDraft.trim());
    } else if (!idDraft.trim()) {
      setIdDraft(node.id);
    }
  };

  const handleTypeSpecificUpdate = (patch: Partial<FlowNode>) => {
    updateNode(node.id, patch);
    if (patch.config) {
      setConfigJson(stringifyJson(patch.config));
      setConfigError(undefined);
    }
  };

  const SpecificEditor = TYPE_SPECIFIC_EDITORS[node.type];

  return (
    <div className="inspector__body">
      <label className="inspector__field">
        <span>Node id</span>
        <input
          type="text"
          value={idDraft}
          onChange={(event) => setIdDraft(event.target.value)}
          onBlur={commitId}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      <div className="inspector__field inspector__field--readonly">
        <span>Type</span>
        <code>{node.type}</code>
      </div>
      {SpecificEditor ? (
        <SpecificEditor node={node} onUpdate={handleTypeSpecificUpdate} />
      ) : (
        <label className="inspector__field">
          <span>config (JSON)</span>
          <textarea
            rows={6}
            value={configJson}
            spellCheck={false}
            onChange={(event) => commitConfig(event.target.value)}
          />
          {configError ? <em className="inspector__error">{configError}</em> : null}
        </label>
      )}
      <label className="inspector__field">
        <span>inputs (JSON)</span>
        <textarea
          rows={5}
          value={inputsJson}
          spellCheck={false}
          onChange={(event) => commitInputs(event.target.value)}
        />
        {inputsError ? <em className="inspector__error">{inputsError}</em> : null}
      </label>
      <label className="inspector__field">
        <span>when</span>
        <input
          type="text"
          value={whenValue}
          placeholder="e.g. route.branch == 'deep'"
          onChange={(event) => commitWhen(event.target.value)}
        />
      </label>
      {saveError ? <p className="inspector__error">{saveError}</p> : null}
      <button type="button" className="inspector__delete" onClick={() => deleteNode(node.id)}>
        Delete node
      </button>
    </div>
  );
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function ReplayNodeInspector({ nodeId }: { nodeId: string }) {
  const runtime = useRunStore((state) => state.nodeRuntimes[nodeId]);
  if (!runtime) {
    return <p className="inspector__empty">Replay node details are unavailable.</p>;
  }

  return (
    <div className="inspector__body">
      <div className="inspector__field inspector__field--readonly">
        <span>Replay node</span>
        <code>{nodeId}</code>
      </div>
      <div className="inspector__field inspector__field--readonly">
        <span>State</span>
        <code>{runtime.state}</code>
      </div>
      <div className="inspector__field inspector__field--readonly">
        <span>Timing</span>
        <code>
          {formatTimestamp(runtime.startedAt)} → {formatTimestamp(runtime.finishedAt)}
          {" "}({formatDuration(runtime.durationMs)})
        </code>
      </div>
      <div className="inspector__field">
        <span>Output</span>
        <pre className="inspector__output-pre">{formatJson(runtime.output)}</pre>
      </div>
      {runtime.meta && Object.keys(runtime.meta).length > 0 ? (
        <div className="inspector__field">
          <span>Meta</span>
          <pre className="inspector__output-pre">{JSON.stringify(runtime.meta, null, 2)}</pre>
        </div>
      ) : null}
      {runtime.error ? <p className="inspector__error">{runtime.error}</p> : null}
    </div>
  );
}

export function Inspector() {
  const flowDraft = useRunStore((state) => state.flowDraft);
  const selectedNodeId = useRunStore((state) => state.selectedNodeId);
  const selectedInspectorRunNodeId = useRunStore((state) => state.selectedInspectorRunNodeId);
  const selectedRunId = useRunStore((state) => state.selectedRunId);
  const isStreaming = useRunStore((state) => state.isStreaming);

  const selectedNode = useMemo(() => {
    if (!flowDraft || !selectedNodeId) return undefined;
    return flowDraft.nodes.find((node) => node.id === selectedNodeId);
  }, [flowDraft, selectedNodeId]);

  const isReplayMode = Boolean(selectedRunId) && !isStreaming;
  const showReplay = isReplayMode && selectedInspectorRunNodeId;
  const showEditor = selectedNode && !isReplayMode;

  return (
    <section className="inspector">
      <p className="eyebrow">Inspector</p>
      {showReplay ? (
        <ReplayNodeInspector nodeId={selectedInspectorRunNodeId} key={selectedInspectorRunNodeId} />
      ) : showEditor ? (
        <NodeEditor node={selectedNode} key={selectedNode.id} />
      ) : (
        <p className="inspector__empty">
          {isReplayMode ? "Select a node in the graph to view its I/O." : "Select a node to edit its configuration."}
        </p>
      )}
    </section>
  );
}
