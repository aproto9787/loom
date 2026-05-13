import { useEffect } from "react";
import { WorkflowTab } from "./AppSections.js";
import { StaticTabView, TabBar } from "./app-shell.js";
import { useRunStore } from "./store.js";
import { SERVER_ORIGIN } from "./sse-run.js";

function normalizeMigrationNotes(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const candidates = [
    record.migrationNotes,
    record.legacyMigrationNotes,
    (record.migration && typeof record.migration === "object"
      ? (record.migration as Record<string, unknown>).notes
      : undefined),
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((note) => {
          if (typeof note === "string") return note;
          if (!note || typeof note !== "object") return "";
          const record = note as Record<string, unknown>;
          const path = typeof record.path === "string" ? record.path : "";
          const from = typeof record.from === "string" ? record.from : "";
          const to = typeof record.to === "string" ? record.to : "";
          const message = typeof record.message === "string" ? record.message : "";
          return [path && from && to ? `${path}: ${from} -> ${to}` : "", message].filter(Boolean).join(" - ");
        })
        .filter((note) => note.trim().length > 0);
    }
    if (typeof candidate === "string" && candidate.trim()) {
      return [candidate];
    }
  }
  return [];
}

export default function App() {
  const activeTab = useRunStore((s) => s.activeTab);
  const flowPath = useRunStore((s) => s.flowPath);
  const availableFlows = useRunStore((s) => s.availableFlows);
  const setAvailableFlows = useRunStore((s) => s.setAvailableFlows);
  const setLoadedFlow = useRunStore((s) => s.setLoadedFlow);
  const setLoadError = useRunStore((s) => s.setLoadError);
  const fetchRoles = useRunStore((s) => s.fetchRoles);
  const fetchRunHistory = useRunStore((s) => s.fetchRunHistory);
  const setActiveTab = useRunStore((s) => s.setActiveTab);

  useEffect(() => {
    fetchRoles(SERVER_ORIGIN);
    fetchRunHistory(SERVER_ORIGIN);
  }, [fetchRoles, fetchRunHistory]);

  useEffect(() => {
    let active = true;
    fetch(`${SERVER_ORIGIN}/flows`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { flows: string[] }) => {
        if (active) setAvailableFlows(data.flows ?? []);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "failed to list flows");
      });
    return () => {
      active = false;
    };
  }, [setAvailableFlows, setLoadError]);

  useEffect(() => {
    if (availableFlows.length === 0 || !availableFlows.includes(flowPath)) {
      return;
    }

    let active = true;
    setLoadedFlow(undefined);
    fetch(`${SERVER_ORIGIN}/flows/get?path=${encodeURIComponent(flowPath)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
        }
        return res.json() as Promise<{ flow: import("@aproto9787/heddle-core").FlowDefinition } & Record<string, unknown>>;
      })
      .then((data) => {
        if (active) setLoadedFlow(data.flow, normalizeMigrationNotes(data));
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "failed to load flow");
      });
    return () => {
      active = false;
    };
  }, [availableFlows, flowPath, setLoadedFlow, setLoadError]);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TabBar activeTab={activeTab} onSelect={setActiveTab} />
      {activeTab === "workflow" && <WorkflowTab />}
      <StaticTabView activeTab={activeTab} />
    </div>
  );
}
