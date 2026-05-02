import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentType, ProviderAuthState, ProviderProfile } from "@aproto9787/heddle-core";

const execFileAsync = promisify(execFile);

export interface ProviderDiscoveryOptions {
  homeDir?: string;
  commandRunner?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

interface ProviderCandidate {
  id: string;
  kind: AgentType;
  displayName: string;
  command: string;
  versionArgs: string[];
  configCandidates: string[];
}

async function defaultCommandRunner(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, { timeout: 5000 });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function authState(commandFound: boolean, configSources: string[]): ProviderAuthState {
  if (!commandFound) {
    return "missing";
  }
  return configSources.length > 0 ? "ready" : "unknown";
}

function normalizeVersion(value: string): string | undefined {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

async function discoverProvider(
  candidate: ProviderCandidate,
  options: Required<ProviderDiscoveryOptions>,
): Promise<ProviderProfile> {
  let commandFound = false;
  let version: string | undefined;
  try {
    const result = await options.commandRunner(candidate.command, candidate.versionArgs);
    commandFound = true;
    version = normalizeVersion(result.stdout || result.stderr);
  } catch {
    commandFound = false;
  }

  const configSources = [];
  for (const source of candidate.configCandidates) {
    if (await pathExists(source)) {
      configSources.push(source);
    }
  }

  return {
    id: candidate.id,
    kind: candidate.kind,
    displayName: candidate.displayName,
    command: candidate.command,
    version,
    authState: authState(commandFound, configSources),
    configSources,
  };
}

export async function discoverProviderProfiles(
  options: ProviderDiscoveryOptions = {},
): Promise<ProviderProfile[]> {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const candidates: ProviderCandidate[] = [
    {
      id: "claude-default",
      kind: "claude-code",
      displayName: "Claude Code",
      command: "claude",
      versionArgs: ["--version"],
      configCandidates: [
        path.join(homeDir, ".claude.json"),
        path.join(homeDir, ".claude"),
      ],
    },
    {
      id: "codex-default",
      kind: "codex",
      displayName: "Codex",
      command: "codex",
      versionArgs: ["--version"],
      configCandidates: [
        path.join(homeDir, ".codex", "auth.json"),
        path.join(homeDir, ".codex", "config.toml"),
      ],
    },
  ];

  return Promise.all(candidates.map((candidate) =>
    discoverProvider(candidate, { homeDir, commandRunner }),
  ));
}
