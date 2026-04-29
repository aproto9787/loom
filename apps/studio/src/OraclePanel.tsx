import { useCallback, useEffect, useState } from "react";
import {
  ORACLE_ADVISOR_TRIGGER_LABELS,
  normalizeOracleAdvisorConfig,
} from "@aproto9787/loom-core";
import {
  getOracleStatus,
  type OracleAdvisorStatus,
} from "./api.js";
import { SERVER_ORIGIN } from "./sse-run.js";
import { useRunStore } from "./store.js";

function StatusBadge({ available }: { available: boolean }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
      available ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
    }`}>
      {available ? "ready" : "missing"}
    </span>
  );
}

function CommandStatus({
  label,
  command,
  available,
  detail,
}: {
  label: string;
  command: string;
  available: boolean;
  detail?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
        <StatusBadge available={available} />
      </div>
      <p className="m-0 mt-2 truncate font-mono text-sm text-slate-900">{command}</p>
      {detail ? (
        <p className="m-0 mt-1 truncate font-mono text-xs text-slate-500" title={detail}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

function connectorState(status: OracleAdvisorStatus | undefined): { label: string; className: string } {
  if (!status) {
    return { label: "checking", className: "bg-slate-100 text-slate-600" };
  }
  if (status.oracle.available) {
    return { label: "installed CLI", className: "bg-emerald-50 text-emerald-700" };
  }
  if (status.npxFallback.available) {
    return { label: "npx fallback", className: "bg-blue-50 text-blue-700" };
  }
  return { label: "not installed", className: "bg-amber-50 text-amber-700" };
}

function PolicyItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
      <p className="m-0 text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="m-0 mt-2 text-sm leading-relaxed text-slate-700">{value}</p>
    </div>
  );
}

export function OraclePanel() {
  const flowDraft = useRunStore((s) => s.flowDraft);
  const selectAgent = useRunStore((s) => s.selectAgent);
  const setAgentConfigTab = useRunStore((s) => s.setAgentConfigTab);
  const setActiveTab = useRunStore((s) => s.setActiveTab);
  const [status, setStatus] = useState<OracleAdvisorStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [loadingStatus, setLoadingStatus] = useState(false);
  const state = connectorState(status);
  const oracleAdvisor = normalizeOracleAdvisorConfig(flowDraft?.orchestrator.oracleAdvisor);
  const triggerText = oracleAdvisor.useFor.length > 0
    ? oracleAdvisor.useFor.map((trigger) => ORACLE_ADVISOR_TRIGGER_LABELS[trigger]).join(", ")
    : "No automatic categories selected.";

  const openLeaderAdvisorSettings = useCallback(() => {
    if (flowDraft?.orchestrator.name) {
      selectAgent([flowDraft.orchestrator.name]);
    }
    setAgentConfigTab("advisors");
    setActiveTab("workflow");
  }, [flowDraft?.orchestrator.name, selectAgent, setActiveTab, setAgentConfigTab]);

  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true);
    setStatusError(undefined);
    try {
      setStatus(await getOracleStatus(SERVER_ORIGIN));
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "failed to load Oracle status");
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  return (
    <section className="mb-7 max-w-4xl border-b border-slate-200 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-wider text-blue-600">
            Advisor connector
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-xl font-semibold text-slate-900">Oracle</h2>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${state.className}`}>
              {state.label}
            </span>
          </div>
          <p className="m-0 mt-1 max-w-2xl text-sm text-slate-600">
            Leaders call Oracle automatically for non-trivial decisions through Loom MCP. This area shows connector health and the active advisory policy.
          </p>
        </div>
        <button
          type="button"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40"
          onClick={refreshStatus}
          disabled={loadingStatus}
        >
          {loadingStatus ? "Checking..." : "Refresh"}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <CommandStatus
          label="CLI"
          command="oracle"
          available={status?.oracle.available ?? false}
          detail={status?.oracle.path}
        />
        <CommandStatus
          label="MCP server"
          command="oracle-mcp"
          available={status?.oracleMcp.available ?? false}
          detail={status?.oracleMcp.path}
        />
        <CommandStatus
          label="Fallback"
          command="npx -y @steipete/oracle"
          available={status?.npxFallback.available ?? false}
          detail={status?.npxFallback.package}
        />
      </div>

      {statusError ? (
        <p className="m-0 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{statusError}</p>
      ) : null}

      <p className="m-0 mt-3 text-xs leading-relaxed text-slate-500">
        Attribution: <span className="font-semibold text-slate-700">{status?.attribution ?? "Oracle by steipete"}</span>. Oracle is external; Loom only detects, invokes, and records it. Install separately with <span className="font-mono">npm install -g @steipete/oracle</span>.
      </p>

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Automatic advisory policy
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              oracleAdvisor.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
            }`}>
              {oracleAdvisor.enabled ? "enabled for leaders" : "disabled for leaders"}
            </span>
            <button
              type="button"
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50"
              onClick={openLeaderAdvisorSettings}
            >
              Edit policy
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
          <PolicyItem
            label="Use for"
            value={oracleAdvisor.enabled ? triggerText : "Automatic Oracle calls are disabled."}
          />
          <PolicyItem
            label="Skip"
            value={oracleAdvisor.skipTrivial ? "Trivial tasks and no-external-advice requests." : "No-external-advice requests only."}
          />
          <PolicyItem
            label="Fallback"
            value={oracleAdvisor.useNpxFallback ? "Installed oracle first; npx fallback allowed." : "Installed oracle only; npx fallback disabled."}
          />
          <PolicyItem
            label="Recording"
            value={oracleAdvisor.recordCalls ? "Leader calls appear in run history." : "Leader calls are not recorded."}
          />
        </div>
      </div>
    </section>
  );
}
