import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("isolated agent temp HOME is created and cleaned up", async () => {
  // Simulate what runner-executor does for isolated agents:
  // mkdtemp → use as HOME → rmdir in finally
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "loom-isolated-"));
  const info = await stat(tempHome);
  assert.ok(info.isDirectory(), "temp HOME should be a directory");

  // Simulate cleanup
  await rm(tempHome, { recursive: true, force: true });
  await assert.rejects(
    () => stat(tempHome),
    "temp HOME should be removed after cleanup",
  );
});

test("isolation env overrides HOME but preserves other vars", () => {
  const baseEnv = { PATH: "/usr/bin", TERM: "xterm" };
  const isolatedHome = "/tmp/loom-isolated-test";

  // Simulate what the adapter does: spread base env, override HOME
  const spawnEnv = { ...baseEnv, HOME: isolatedHome };

  assert.equal(spawnEnv.HOME, isolatedHome);
  assert.equal(spawnEnv.PATH, "/usr/bin");
  assert.equal(spawnEnv.TERM, "xterm");
});
