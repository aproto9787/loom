import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildInteractiveCodexAgentsMd } from "./session-prompts.js";

export interface CodexInstructionHome {
  codexHome: string;
  cleanup: () => Promise<void>;
}

interface CreateCodexInstructionHomeOptions {
  instructions: string;
  configAppend?: string;
  writeAgents?: boolean;
  realCodexHome?: string;
  parentDir?: string;
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function mirrorCodexEntry(source: string, destination: string): Promise<void> {
  const stat = await lstat(source);
  if (stat.isDirectory()) {
    await symlink(source, destination, "dir");
    return;
  }
  if (stat.isFile()) {
    try {
      await symlink(source, destination, "file");
    } catch {
      await copyFile(source, destination);
    }
  }
}

export async function createCodexInstructionHome(
  options: CreateCodexInstructionHomeOptions,
): Promise<CodexInstructionHome> {
  const realCodexHome = path.resolve(options.realCodexHome ?? path.join(os.homedir(), ".codex"));
  const parentDir = path.resolve(options.parentDir ?? path.join(os.homedir(), ".heddle", "codex-root-homes"));
  await mkdir(parentDir, { recursive: true });
  const codexHome = await mkdtemp(path.join(parentDir, "root-"));

  try {
    const entries = await readdir(realCodexHome, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (entry.name === "AGENTS.md") {
        return;
      }
      if (entry.name === "config.toml" && options.configAppend?.trim()) {
        return;
      }
      await mirrorCodexEntry(path.join(realCodexHome, entry.name), path.join(codexHome, entry.name));
    }));
  } catch {
    // A missing real Codex home is not fatal; the flow instructions still seed this home.
  }

  const configPath = path.join(codexHome, "config.toml");
  if (options.configAppend?.trim()) {
    const existing = await readOptional(path.join(realCodexHome, "config.toml"));
    await writeFile(
      configPath,
      `${existing?.trimEnd() ?? ""}\n\n${options.configAppend.trim()}\n`,
      "utf8",
    );
  }

  if (options.writeAgents !== false) {
    const globalAgents = await readOptional(path.join(realCodexHome, "AGENTS.md"));
    await writeFile(
      path.join(codexHome, "AGENTS.md"),
      buildInteractiveCodexAgentsMd(globalAgents, options.instructions),
      "utf8",
    );
  }

  return {
    codexHome,
    cleanup: async () => {
      await rm(codexHome, { recursive: true, force: true });
    },
  };
}
