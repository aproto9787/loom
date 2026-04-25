import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCodexInstructionHome } from "./codex-home.js";

test("createCodexInstructionHome mirrors host Codex home and replaces AGENTS.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "loom-codex-home-test-"));
  const realCodexHome = path.join(root, "real");
  const parentDir = path.join(root, "homes");
  await mkdir(path.join(realCodexHome, "skills"), { recursive: true });
  await writeFile(path.join(realCodexHome, "config.toml"), "model = \"gpt-5.5\"\n", "utf8");
  await writeFile(path.join(realCodexHome, "AGENTS.md"), "# Global Rules\nUse Korean.\n", "utf8");
  await writeFile(path.join(realCodexHome, "RTK.md"), "# RTK\n", "utf8");

  const home = await createCodexInstructionHome({
    realCodexHome,
    parentDir,
    instructions: "flow rule\nworker roster",
  });

  try {
    const agents = await readFile(path.join(home.codexHome, "AGENTS.md"), "utf8");
    assert.match(agents, /# Global Rules/);
    assert.match(agents, /# Loom flow instructions/);
    assert.match(agents, /flow rule\nworker roster/);
    assert.match(agents, /Wait for the user's next task before doing any work\./);

    const config = await lstat(path.join(home.codexHome, "config.toml"));
    const skills = await lstat(path.join(home.codexHome, "skills"));
    assert.equal(config.isSymbolicLink(), true);
    assert.equal(skills.isSymbolicLink(), true);
  } finally {
    await home.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
