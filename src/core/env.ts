import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface RunResult { code: number; stdout: string; stderr: string }

export interface RunOptions {
  /** inherit: user sees prompts (login flows). pipe: capture output. */
  stdio: "inherit" | "pipe";
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Kill the child after this many ms (pipe mode only; login flows are never limited). */
  timeoutMs?: number;
}

/** Everything a provider needs from the outside world, injectable for tests. */
export interface Env {
  home: string;
  xdgDataHome: string;
  xdgConfigHome: string;
  vars: Record<string, string | undefined>;
  run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult>;
}

export function realEnv(vars: Record<string, string | undefined> = process.env): Env {
  const home = vars["HOME"] ?? os.homedir();
  return {
    home,
    xdgDataHome: vars["XDG_DATA_HOME"] ?? path.join(home, ".local", "share"),
    xdgConfigHome: vars["XDG_CONFIG_HOME"] ?? path.join(home, ".config"),
    vars,
    run(cmd, args, opts) {
      return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
          stdio: opts.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
          env: { ...vars, ...opts.env },
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        });
        let stdout = "";
        let stderr = "";
        const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
        child.stdout?.on("data", (d) => (stdout += d));
        child.stderr?.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
      });
    },
  };
}
