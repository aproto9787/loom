import { type ReactNode } from "react";
import { CustomPanel } from "./CustomPanel.js";
import FlowMdTab from "./FlowMdTab.js";
import DelegationTab from "./DelegationTab.js";
import { RolesPanel } from "./RolesPanel.js";
import { RunsPanel } from "./AppSections.js";
import { OraclePanel } from "./OraclePanel.js";

export const TABS = ["workflow", "flowMd", "delegation", "runs", "oracle", "roles", "custom"] as const;
const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  workflow: "Workflow",
  flowMd: "flow.md",
  delegation: "Delegation",
  runs: "Runs",
  oracle: "Oracle",
  roles: "Roles",
  custom: "Custom",
};

export function TabBar({
  activeTab,
  onSelect,
}: {
  activeTab: (typeof TABS)[number];
  onSelect: (tab: (typeof TABS)[number]) => void;
}) {
  return (
    <nav className="flex bg-white border-b border-slate-200 px-6 shrink-0">
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          className={`px-5 py-2.5 text-sm font-medium capitalize border-b-2 transition-colors ${
            activeTab === tab
              ? "text-slate-900 border-blue-500"
              : "text-slate-500 border-transparent hover:text-slate-700"
          }`}
          onClick={() => onSelect(tab)}
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
    </nav>
  );
}

export function StaticTabView({ activeTab }: { activeTab: (typeof TABS)[number] }) {
  if (activeTab === "flowMd") {
    return <FlowMdTab />;
  }
  if (activeTab === "delegation") {
    return <DelegationTab />;
  }
  if (activeTab === "runs") {
    return <RunsPanel />;
  }
  if (activeTab === "oracle") {
    return <OraclePanel />;
  }
  if (activeTab === "roles") {
    return <RolesPanel />;
  }
  if (activeTab === "custom") {
    return <CustomPanel />;
  }
  return null;
}
