import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

export const oracleAdvisorPlugin = {
  id: "oracle",
  displayName: "Oracle",
  kind: "external-advisor",
  routeBasePath: "/plugins/oracle",
  runFlowPath: "plugins/oracle",
  mcpToolName: "loom_oracle",
  mcpStatusToolName: "loom_oracle_status",
  attribution: "Oracle by steipete",
  packageName: "@steipete/oracle",
  installCommand: "npm install -g @steipete/oracle",
} as const;

export interface OracleCommandStatus {
  command: string;
  available: boolean;
  path?: string;
}

export interface OracleAdvisorStatus {
  plugin: {
    id: typeof oracleAdvisorPlugin.id;
    displayName: typeof oracleAdvisorPlugin.displayName;
    kind: typeof oracleAdvisorPlugin.kind;
  };
  oracle: OracleCommandStatus;
  oracleMcp: OracleCommandStatus;
  npxFallback: {
    command: "npx";
    package: typeof oracleAdvisorPlugin.packageName;
    available: boolean;
  };
  attribution: typeof oracleAdvisorPlugin.attribution;
  note: string;
}

export interface OracleAdvisorOptions {
  prompt: string;
  files: string[];
  args: string[];
  cwd: string;
  timeoutSeconds: number;
  useNpxFallback: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface OracleAdvisorResult {
  plugin: {
    id: typeof oracleAdvisorPlugin.id;
    kind: typeof oracleAdvisorPlugin.kind;
  };
  status: "done" | "error" | "unavailable";
  provider?: "oracle" | "npx";
  command: string[];
  exitCode?: number;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
  installHint?: string;
  attribution: typeof oracleAdvisorPlugin.attribution;
}

const INSTALL_HINT = `Install Oracle separately with \`${oracleAdvisorPlugin.installCommand}\`, or allow Loom to use \`npx -y ${oracleAdvisorPlugin.packageName}\` fallback.`;

function pluginResultBase() {
  return {
    plugin: {
      id: oracleAdvisorPlugin.id,
      kind: oracleAdvisorPlugin.kind,
    },
    attribution: oracleAdvisorPlugin.attribution,
  };
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (command.includes("/") || command.includes("\\")) {
    return [command];
  }

  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  return pathEntries(env).flatMap((dir) =>
    extensions.map((ext) => path.join(dir, `${command}${ext}`)),
  );
}

export async function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const candidate of executableCandidates(command, env)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH.
    }
  }
  return undefined;
}

export async function getOracleAdvisorStatus(env: NodeJS.ProcessEnv = process.env): Promise<OracleAdvisorStatus> {
  const [oraclePath, oracleMcpPath, npxPath] = await Promise.all([
    findExecutable("oracle", env),
    findExecutable("oracle-mcp", env),
    findExecutable("npx", env),
  ]);

  return {
    plugin: {
      id: oracleAdvisorPlugin.id,
      displayName: oracleAdvisorPlugin.displayName,
      kind: oracleAdvisorPlugin.kind,
    },
    oracle: {
      command: "oracle",
      available: oraclePath !== undefined,
      path: oraclePath,
    },
    oracleMcp: {
      command: "oracle-mcp",
      available: oracleMcpPath !== undefined,
      path: oracleMcpPath,
    },
    npxFallback: {
      command: "npx",
      package: oracleAdvisorPlugin.packageName,
      available: npxPath !== undefined,
    },
    attribution: oracleAdvisorPlugin.attribution,
    note: "Oracle is an external advisor plugin. Loom does not vendor Oracle and does not require it for core workflows.",
  };
}

function buildOracleArgs(options: OracleAdvisorOptions): string[] {
  const args = ["-p", options.prompt];
  for (const file of options.files) {
    args.push("--file", file);
  }
  args.push(...options.args);
  return args;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutSeconds: number },
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exited = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (!exited) child.kill("SIGTERM");
    }, options.timeoutSeconds * 1000);
    timeout.unref();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      exited = true;
      clearTimeout(timeout);
      resolve({
        exitCode: signal ? 1 : (code ?? 0),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export async function runOracleAdvisor(options: OracleAdvisorOptions): Promise<OracleAdvisorResult> {
  const env = options.env ?? process.env;
  const oraclePath = await findExecutable("oracle", env);
  const npxPath = oraclePath ? undefined : await findExecutable("npx", env);
  const oracleArgs = buildOracleArgs(options);
  const command = oraclePath
    ? [oraclePath, ...oracleArgs]
    : options.useNpxFallback && npxPath
      ? [npxPath, "-y", oracleAdvisorPlugin.packageName, ...oracleArgs]
      : [];

  if (command.length === 0) {
    return {
      ...pluginResultBase(),
      status: "unavailable",
      command: [],
      stdout: "",
      stderr: "",
      installHint: INSTALL_HINT,
    };
  }

  try {
    const result = await runProcess(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env,
      timeoutSeconds: options.timeoutSeconds,
    });
    return {
      ...pluginResultBase(),
      status: result.exitCode === 0 ? "done" : "error",
      provider: oraclePath ? "oracle" : "npx",
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      ...pluginResultBase(),
      status: "error",
      provider: oraclePath ? "oracle" : "npx",
      command,
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
