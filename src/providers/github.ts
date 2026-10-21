import path from "node:path";
import fs from "node:fs/promises";
import { UserError } from "../core/errors.js";
import type { Env } from "../core/env.js";
import { withoutOverrides, type Provider, type Identity, type VerifyResult } from "./types.js";

function configDir(env: Env): string {
  return env.vars["GH_CONFIG_DIR"] ?? path.join(env.xdgConfigHome, "gh");
}

/** `user:` directly under the github.com host (4-space indent in gh's YAML). */
const USER_RE = /^github\.com:\s*\n(?:^ {4}\S.*\n|^ {8,}.*\n)*? {4}user:[ \t]*(\S+)/m;
const TOKEN_RE = /^\s+oauth_token:\s*\S+/m;

async function readHosts(p: string): Promise<string | null> {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

export const github: Provider = {
  id: "github",
  displayName: "GitHub",
  installHint: "https://cli.github.com (gh)",
  cli: "gh",
  loginMode: "isolated",
  storage: {
    summary: "gh keeps OAuth tokens per host in hosts.yml; config.yml holds only preferences and is left alone.",
    location: "$GH_CONFIG_DIR/hosts.yml (default $XDG_CONFIG_HOME/gh/hosts.yml)",
    login: "`gh auth login` runs with GH_CONFIG_DIR pointing at a scratch dir, so the active login is untouched.",
    identity: "Offline: the `user:` line in hosts.yml (also the mismatch fingerprint). Online: `gh api user`; `gh auth status` for checks.",
    overrideEnv: ["GH_TOKEN", "GITHUB_TOKEN"],
    caveats: [
      "On macOS and keyring-equipped Linux, gh stores the token in the OS keychain and hosts.yml has no oauth_token line; acctx cannot capture that. Re-login with `gh auth login --insecure-storage`.",
      "gh has a native `gh auth switch` for multiple users on one host; acctx adds the same cross-provider workflow and backups.",
    ],
    verified: "Linux, gh 2.x: isolation via GH_CONFIG_DIR, import, check, use (cloned profile). Login flow not exercised.",
  },

  files(env) {
    return [{ name: "hosts.yml", path: path.join(configDir(env), "hosts.yml"), required: true, mode: 0o600 }];
  },

  async loginIsolated(dir, env) {
    const res = await env.run("gh", ["auth", "login"], { stdio: "inherit", env: { GH_CONFIG_DIR: dir, ...withoutOverrides(github) } })
      .catch(missingCli);
    if (res.code !== 0) throw new UserError("GitHub login failed or was cancelled.", "Nothing was saved.");
  },

  async validateFiles(dir) {
    const text = await readHosts(path.join(dir, "hosts.yml"));
    if (text && !TOKEN_RE.test(text)) {
      return "hosts.yml has no oauth_token: the token is in the OS keyring, which acctx cannot capture. Re-login with `gh auth login --insecure-storage`.";
    }
    return null;
  },

  async fingerprint(paths) {
    const text = paths["hosts.yml"] ? await readHosts(paths["hosts.yml"]) : null;
    return text ? (USER_RE.exec(text)?.[1] ?? null) : null;
  },

  async identify(dir, env): Promise<Identity | null> {
    const offline = await github.fingerprint!({ "hosts.yml": path.join(dir, "hosts.yml") });
    const res = await env.run("gh", ["api", "user", "-q", ".login"], {
      stdio: "pipe", timeoutMs: 20_000, env: { GH_CONFIG_DIR: dir, ...withoutOverrides(github) },
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const login = res.code === 0 ? res.stdout.trim() : "";
    const label = login || offline;
    return label ? { label, details: { host: "github.com" } } : null;
  },

  async verify(dir, env): Promise<VerifyResult> {
    const problem = await github.validateFiles!(dir);
    if (problem) return { ok: false, reason: problem };
    const res = await env.run("gh", ["auth", "status", "-h", "github.com"], {
      stdio: "pipe", timeoutMs: 20_000, env: { GH_CONFIG_DIR: dir, ...withoutOverrides(github) },
    }).catch((e: NodeJS.ErrnoException) => ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? "gh CLI not found" : e.message }));
    if (res.code === 0) {
      const m = /account (\S+)/.exec(res.stdout + res.stderr);
      return { ok: true, label: m?.[1] ?? "" };
    }
    const line = (res.stderr + res.stdout).split("\n").map((l) => l.trim()).filter((l) => /fail|invalid|not logged|error|not found/i.test(l))[0];
    return { ok: false, reason: line ?? `gh exited ${res.code}` };
  },
};

function missingCli(e: NodeJS.ErrnoException): never {
  if (e.code === "ENOENT") throw new UserError("The `gh` CLI is not installed or not on PATH.", `Install it: ${github.installHint}`);
  throw e;
}
