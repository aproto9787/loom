import { useEffect, useMemo, useState } from "react";
import type { AgentConfig, AgentTeamTag, TeamDefinition } from "@loom/core";
import { darkButton, darkCard, darkCardMuted, inputDark, selectDark } from "./panelStyles.js";
import { useRunStore } from "./store.js";

interface TeamDraftValue {
  id: string;
  description: string;
  claudeMdRef: string;
}

function collectAgentsWithPath(agent: AgentConfig, path: string[] = [agent.name]): Array<{ agent: AgentConfig; path: string[] }> {
  return [
    { agent, path },
    ...((agent.agents ?? []).flatMap((child) => collectAgentsWithPath(child, [...path, child.name]))),
  ];
}

function nextTeamId(teams: TeamDefinition[]): string {
  let index = teams.length + 1;
  const existing = new Set(teams.map((team) => team.id));
  while (existing.has(`team-${index}`)) {
    index += 1;
  }
  return `team-${index}`;
}

function replaceAgentTeamTags(tags: AgentTeamTag[] | undefined, currentId: string, nextId?: string): AgentTeamTag[] | undefined {
  const nextTags = (tags ?? []).flatMap((tag) => {
    if (tag.id !== currentId) {
      return [tag];
    }
    if (!nextId) {
      return [];
    }
    return [{ ...tag, id: nextId }];
  });

  return nextTags.length > 0 ? nextTags : undefined;
}

export default function TeamsTab() {
  const flowDraft = useRunStore((state) => state.flowDraft);
  const updateFlowDraft = useRunStore((state) => state.updateFlowDraft);
  const updateAgent = useRunStore((state) => state.updateAgent);
  const [teamValues, setTeamValues] = useState<Record<string, TeamDraftValue>>({});

  const teams = flowDraft?.teams ?? [];
  const libraryEntries = useMemo(() => Object.entries(flowDraft?.claudeMdLibrary ?? {}), [flowDraft?.claudeMdLibrary]);

  useEffect(() => {
    setTeamValues(
      Object.fromEntries(
        teams.map((team) => [
          team.id,
          {
            id: team.id,
            description: team.description ?? "",
            claudeMdRef: team.claudeMdRef ?? "none",
          },
        ]),
      ),
    );
  }, [teams]);

  const agentEntries = useMemo(() => {
    if (!flowDraft) {
      return [] as Array<{ agent: AgentConfig; path: string[] }>;
    }
    return collectAgentsWithPath(flowDraft.orchestrator);
  }, [flowDraft]);

  const teamMembers = useMemo(() => {
    const members: Record<string, Array<{ agent: AgentConfig; path: string[] }>> = {};
    for (const entry of agentEntries) {
      for (const tag of entry.agent.team ?? []) {
        members[tag.id] ??= [];
        members[tag.id].push(entry);
      }
    }
    return members;
  }, [agentEntries]);

  if (!flowDraft) {
    return (
      <div className="flex flex-col gap-4 p-5">
        <p className="m-0 rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-6 text-sm text-slate-400">
          Load a flow to manage agent teams.
        </p>
      </div>
    );
  }

  const setTeams = (nextTeams: TeamDefinition[]) => {
    updateFlowDraft({ teams: nextTeams.length > 0 ? nextTeams : undefined });
  };

  const commitTeam = (currentId: string) => {
    const draft = teamValues[currentId];
    if (!draft) {
      return;
    }

    const nextId = draft.id.trim();
    if (!nextId) {
      setTeamValues((state) => ({
        ...state,
        [currentId]: { ...draft, id: currentId },
      }));
      return;
    }

    if (nextId !== currentId && teams.some((team) => team.id === nextId)) {
      setTeamValues((state) => ({
        ...state,
        [currentId]: { ...draft, id: currentId },
      }));
      return;
    }

    setTeams(
      teams.map((team) =>
        team.id === currentId
          ? {
              id: nextId,
              description: draft.description.trim() || undefined,
              claudeMdRef: draft.claudeMdRef === "none" ? undefined : draft.claudeMdRef,
            }
          : team,
      ),
    );

    if (nextId !== currentId) {
      for (const entry of agentEntries) {
        const nextTeam = replaceAgentTeamTags(entry.agent.team, currentId, nextId);
        if (nextTeam !== entry.agent.team) {
          updateAgent(entry.path, { team: nextTeam });
        }
      }
    }
  };

  const addTeam = () => {
    const id = nextTeamId(teams);
    setTeams([
      ...teams,
      {
        id,
        description: undefined,
        claudeMdRef: undefined,
      },
    ]);
  };

  const deleteTeam = (teamId: string) => {
    setTeams(teams.filter((team) => team.id !== teamId));

    for (const entry of agentEntries) {
      const nextTeam = replaceAgentTeamTags(entry.agent.team, teamId);
      if (nextTeam !== entry.agent.team) {
        updateAgent(entry.path, { team: nextTeam });
      }
    }
  };

  return (
    <div className="flex flex-col gap-5 p-5">
      <section className={`flex items-start justify-between gap-4 p-5 ${darkCardMuted}`}>
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Teams</p>
          <p className="m-0 mt-2 text-sm leading-6 text-slate-500">
            Define reusable teams and assign agents to them from the Basic panel.
          </p>
        </div>
        <button type="button" className={darkButton} onClick={addTeam}>
          Add team
        </button>
      </section>

      {teams.length === 0 ? (
        <section className={`p-5 ${darkCard}`}>
          <p className="m-0 rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-6 text-sm text-slate-400">
            No teams yet. Add a team to start tagging agents.
          </p>
        </section>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {teams.map((team) => {
            const draft = teamValues[team.id] ?? {
              id: team.id,
              description: team.description ?? "",
              claudeMdRef: team.claudeMdRef ?? "none",
            };
            const members = teamMembers[team.id] ?? [];

            return (
              <article key={team.id} className={`flex flex-col gap-4 p-5 ${darkCard}`}>
                <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
                  <div>
                    <p className="m-0 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Team</p>
                    <p className="m-0 mt-1 text-sm text-slate-500">{members.length} assigned agent{members.length === 1 ? "" : "s"}</p>
                  </div>
                  <button
                    type="button"
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/20"
                    onClick={() => deleteTeam(team.id)}
                  >
                    Delete
                  </button>
                </div>

                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>Name</span>
                  <input
                    type="text"
                    className={inputDark}
                    value={draft.id}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      setTeamValues((state) => ({
                        ...state,
                        [team.id]: {
                          ...draft,
                          id: nextId,
                        },
                      }));
                    }}
                    onBlur={() => commitTeam(team.id)}
                  />
                </label>

                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>Description</span>
                  <textarea
                    className={`${inputDark} min-h-[120px]`}
                    value={draft.description}
                    rows={4}
                    placeholder="What does this team handle?"
                    onChange={(event) => {
                      const description = event.target.value;
                      setTeamValues((state) => ({
                        ...state,
                        [team.id]: {
                          ...draft,
                          description,
                        },
                      }));
                    }}
                    onBlur={() => commitTeam(team.id)}
                  />
                </label>

                <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>CLAUDE.md Ref</span>
                  <select
                    className={selectDark}
                    value={draft.claudeMdRef}
                    onChange={(event) => {
                      const claudeMdRef = event.target.value;
                      setTeamValues((state) => ({
                        ...state,
                        [team.id]: {
                          ...draft,
                          claudeMdRef,
                        },
                      }));
                      queueMicrotask(() => commitTeam(team.id));
                    }}
                  >
                    <option value="none">none</option>
                    {libraryEntries.map(([key]) => (
                      <option key={key} value={key}>
                        {key}
                      </option>
                    ))}
                  </select>
                </label>

                <div className={`p-4 ${darkCardMuted}`}>
                  <p className="m-0 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Agents</p>
                  {members.length === 0 ? (
                    <p className="m-0 mt-3 text-sm text-slate-500">No agents assigned to this team.</p>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {members.map(({ agent, path }) => {
                        const teamTag = agent.team?.find((tag) => tag.id === team.id);
                        const pathLabel = path.join(" / ");
                        return (
                          <span
                            key={pathLabel}
                            className="rounded-full border border-blue-500/40 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-100"
                            title={pathLabel}
                          >
                            {agent.name}
                            {teamTag?.role ? ` (${teamTag.role})` : ""}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
