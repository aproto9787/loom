#!/usr/bin/env node

import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageDir, "../..");
const sourceDir = path.join(repoRoot, "examples");
const targetDir = path.join(packageDir, "examples");
const command = process.argv[2] ?? "copy";

if (command === "clean") {
  await rm(targetDir, { recursive: true, force: true });
} else if (command === "copy") {
  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, { recursive: true });
} else {
  console.error(`Unknown pack-examples command: ${command}`);
  process.exit(1);
}
