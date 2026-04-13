import { useEffect } from "react";
import { WorkflowTab } from "./AppSections.js";
import { StaticTabView, TabBar } from "./app-shell.js";
import { useRunStore } from "./store.js";
import { SERVER_ORIGIN } from "./sse-run.js";

export default function App() {
  const activeTab = useRunStore((s) => s.activeTab);
  const flowPath = useRunStore((s) => s.flowPath);
  const setAvailableFlows = useRunStore((s) => s.setAvailableFlows);
  const setLoadedFlow = useRunStore((s) => s.setLoadedFlow);
  const setLoadError = useRunStore((s) => s.setLoadError);
  const fetchRoles = useRunStore((s) => s.fetchRoles);
  const setActiveTab = useRunStore((s) => s.setActiveTab);

  useEffect(() => {
    fetchRoles(SERVER_ORIGIN);
  }, [fetchRoles]);

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
    let active = true;
    setLoadedFlow(undefined);
    fetch(`${SERVER_ORIGIN}/flows/get?path=${encodeURIComponent(flowPath)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
        }
        return res.json() as Promise<{ flow: import("@loom/core").FlowDefinition }>;
      })
      .then((data) => {
        if (active) setLoadedFlow(data.flow);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "failed to load flow");
      });
    return () => {
      active = false;
    };
  }, [flowPath, setLoadedFlow, setLoadError]);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TabBar activeTab={activeTab} onSelect={setActiveTab} />
      {activeTab === "workflow" && <WorkflowTab />}
      <StaticTabView activeTab={activeTab} />
    </div>
  );
}
