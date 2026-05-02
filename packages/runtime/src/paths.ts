import path from "node:path";

export interface RuntimePathOptions {
  cwd?: string;
  workspaceRoot?: string;
  flowPath?: string;
}

export interface RuntimePaths {
  cwd: string;
  workspaceRoot: string;
  flowPath?: string;
  flowDir?: string;
  resourceRoot: string;
  stateDir: string;
}

/**
 * Resolve the repository/workspace root for source checkouts.
 *
 * Built runtime files live under packages/runtime/dist, so ../../.. points at
 * the repo root. This preserves the previous server behavior while giving new
 * call sites an explicit workspaceRoot escape hatch.
 */
export function defaultWorkspaceRoot(): string {
  return path.resolve(import.meta.dirname, "../../..");
}

export function createRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot());
  const flowPath = options.flowPath
    ? path.isAbsolute(options.flowPath)
      ? options.flowPath
      : path.resolve(workspaceRoot, options.flowPath)
    : undefined;

  return {
    cwd,
    workspaceRoot,
    flowPath,
    flowDir: flowPath ? path.dirname(flowPath) : undefined,
    resourceRoot: workspaceRoot,
    stateDir: path.join(workspaceRoot, ".heddle"),
  };
}
