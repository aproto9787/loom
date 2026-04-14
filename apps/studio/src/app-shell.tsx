import { type ReactNode } from "react";
import { CustomPanel } from "./CustomPanel.js";
import ClaudeMdTab from "./ClaudeMdTab.js";
import DelegationTab from "./DelegationTab.js";
import { RolesPanel } from "./RolesPanel.js";
import { RunsPanel } from "./AppSections.js";
import TeamsTab from "./TeamsTab.js";

export const TABS = ["workflow", "claudeMd", "delegation", "teams", "runs", "roles", "custom"] as const;

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
          {tab}
        </button>
      ))}
    </nav>
  );
}

export function StaticTabView({ activeTab }: { activeTab: (typeof TABS)[number] }) {
  if (activeTab === "claudeMd") {
    return <ClaudeMdTab />;
  }
  if (activeTab === "delegation") {
    return <DelegationTab />;
  }
  if (activeTab === "teams") {
    return <TeamsTab />;
  }
  if (activeTab === "runs") {
    return <RunsPanel />;
  }
  if (activeTab === "roles") {
    return <RolesPanel />;
  }
  if (activeTab === "custom") {
    return <CustomPanel />;
  }
  return null;
}
