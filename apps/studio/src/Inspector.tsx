import { useEffect, useMemo, useState } from "react";
import type { FlowNode } from "@loom/core";
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

export function Inspector() {
  const flowDraft = useRunStore((state) => state.flowDraft);
  const selectedNodeId = useRunStore((state) => state.selectedNodeId);

  const selectedNode = useMemo(() => {
    if (!flowDraft || !selectedNodeId) return undefined;
    return flowDraft.nodes.find((node) => node.id === selectedNodeId);
  }, [flowDraft, selectedNodeId]);

  return (
    <section className="inspector">
      <p className="eyebrow">Inspector</p>
      {selectedNode ? (
        <NodeEditor node={selectedNode} key={selectedNode.id} />
      ) : (
        <p className="inspector__empty">Select a node to edit its configuration.</p>
      )}
    </section>
  );
}
