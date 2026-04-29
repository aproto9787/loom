import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getOracleStatus,
  runOracleAdvisor,
  type OracleAdvisorResult,
  type OracleAdvisorStatus,
} from "./api.js";
import { SERVER_ORIGIN } from "./sse-run.js";
import { useRunStore } from "./store.js";

const inputLight =
  "px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-900 text-sm font-mono placeholder:text-slate-400 focus:outline-none focus:border-blue-400 transition-colors";

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function StatusBadge({ available }: { available: boolean }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
      available ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
    }`}>
      {available ? "available" : "missing"}
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
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
          <p className="m-0 mt-1 font-mono text-sm text-slate-900">{command}</p>
        </div>
        <StatusBadge available={available} />
      </div>
      {detail ? <p className="m-0 mt-3 truncate font-mono text-xs text-slate-500">{detail}</p> : null}
    </div>
  );
}

function resultText(result: OracleAdvisorResult | undefined): string {
  if (!result) return "";
  return result.stdout || result.stderr || result.installHint || "";
}

export function OraclePanel() {
  const [status, setStatus] = useState<OracleAdvisorStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState("");
  const [args, setArgs] = useState("--dry-run\nsummary");
  const [timeoutSeconds, setTimeoutSeconds] = useState(1800);
  const [useNpxFallback, setUseNpxFallback] = useState(true);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [result, setResult] = useState<OracleAdvisorResult>();
  const fetchRunHistory = useRunStore((s) => s.fetchRunHistory);
  const selectRun = useRunStore((s) => s.selectRun);
  const setActiveTab = useRunStore((s) => s.setActiveTab);

  const canRun = prompt.trim().length > 0 && !running;
  const parsedFiles = useMemo(() => lines(files), [files]);
  const parsedArgs = useMemo(() => lines(args), [args]);

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

  const handleRun = useCallback(async () => {
    if (!canRun) return;
    setRunning(true);
    setRunError(undefined);
    setResult(undefined);
    setRunId(undefined);
    try {
      const response = await runOracleAdvisor(SERVER_ORIGIN, {
        prompt: prompt.trim(),
        files: parsedFiles,
        args: parsedArgs,
        timeoutSeconds,
        useNpxFallback,
      });
      setRunId(response.runId);
      setResult(response.result);
      await fetchRunHistory(SERVER_ORIGIN);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Oracle run failed");
    } finally {
      setRunning(false);
    }
  }, [canRun, fetchRunHistory, parsedArgs, parsedFiles, prompt, timeoutSeconds, useNpxFallback]);

  const openRun = useCallback(async () => {
    if (!runId) return;
    await selectRun(SERVER_ORIGIN, runId);
    setActiveTab("runs");
  }, [runId, selectRun, setActiveTab]);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-white">
      <header className="border-b border-slate-200 px-6 py-5">
        <div className="flex flex-col gap-1">
          <p className="m-0 text-xs font-semibold uppercase tracking-wider text-blue-600">
            Plugin
          </p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="m-0 text-2xl font-semibold text-slate-950">Oracle</h1>
              <p className="m-0 mt-1 text-sm text-slate-600">
                Leaders call this advisor during non-trivial decisions; this panel is for status checks and manual probes.
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
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[360px_1fr]">
        <aside className="border-b border-slate-200 bg-slate-50 p-5 lg:border-b-0 lg:border-r">
          <div className="flex flex-col gap-3">
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
            {statusError ? (
              <p className="m-0 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{statusError}</p>
            ) : null}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="m-0 text-xs font-semibold uppercase tracking-wider text-slate-500">
                Attribution
              </p>
              <p className="m-0 mt-2 text-sm font-medium text-slate-900">
                {status?.attribution ?? "Oracle by steipete"}
              </p>
              <p className="m-0 mt-2 text-xs leading-relaxed text-slate-500">
                Plugin package is part of Loom; Oracle itself installs separately with <span className="font-mono">npm install -g @steipete/oracle</span>.
              </p>
            </div>
          </div>
        </aside>

        <section className="p-6">
          <div className="grid max-w-5xl grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Prompt</span>
                <textarea
                  className={`${inputLight} min-h-[170px] resize-y leading-relaxed`}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Probe the advisor manually. Leaders use the same plugin from Loom MCP."
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Files</span>
                <textarea
                  className={`${inputLight} min-h-[96px] resize-y leading-relaxed`}
                  value={files}
                  onChange={(event) => setFiles(event.target.value)}
                  placeholder={"packages/mcp/src/**/*.ts\napps/studio/src/**/*.tsx"}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Args</span>
                <textarea
                  className={`${inputLight} min-h-[74px] resize-y leading-relaxed`}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder={"--engine browser\n--dry-run summary"}
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Timeout</span>
                  <input
                    type="number"
                    min={1}
                    className={inputLight}
                    value={timeoutSeconds}
                    onChange={(event) => setTimeoutSeconds(Number(event.target.value) || 1)}
                  />
                </label>
                <label className="flex items-end gap-2 pb-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={useNpxFallback}
                    onChange={(event) => setUseNpxFallback(event.target.checked)}
                  />
                  Use npx fallback when oracle is missing
                </label>
              </div>

              {runError ? <p className="m-0 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{runError}</p> : null}

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-40"
                  onClick={handleRun}
                  disabled={!canRun}
                >
                  {running ? "Running..." : "Probe Oracle"}
                </button>
                {runId ? (
                  <button
                    type="button"
                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    onClick={openRun}
                  >
                    Open Run
                  </button>
                ) : null}
              </div>
            </div>

            <div className="flex min-h-[360px] flex-col rounded-xl border border-slate-200 bg-slate-950 text-slate-100">
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
                <p className="m-0 text-xs font-semibold uppercase tracking-wider text-slate-400">Result</p>
                {result ? (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    result.status === "done" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
                  }`}>
                    {result.status}
                  </span>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {result ? (
                  <div className="flex flex-col gap-4">
                    <div>
                      <p className="m-0 text-xs font-semibold uppercase tracking-wider text-slate-500">Command</p>
                      <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-900 p-3 text-xs text-slate-300">
                        {result.command.join(" ")}
                      </pre>
                    </div>
                    <pre className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-100">
                      {resultText(result) || "(no output)"}
                    </pre>
                  </div>
                ) : (
                  <p className="m-0 text-sm text-slate-500">Oracle output will appear here.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
