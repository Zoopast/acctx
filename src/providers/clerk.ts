import fs from "node:fs/promises";
import path from "node:path";
import { UserError } from "../core/errors.js";
import { exists, readJson, removeIfExists, writeAtomic } from "../core/fsx.js";
import type { Env, RunResult } from "../core/env.js";
import type { LiveStore } from "../core/livestore.js";
import { withoutOverrides, type Provider, type Identity, type VerifyResult } from "./types.js";

/**
 * The Clerk CLI keeps its OAuth session in the OS keyring via @napi-rs/keyring
 * (service "clerk-cli", account "oauth-access-token") and only falls back to a
 * plain `credentials` file when no keyring is usable. acctx mirrors that:
 * session.json in a profile is the JSON the CLI stores, config.json is the
 * CLI's own config (userId, telemetry flags).
 */
const SERVICE = "clerk-cli";
const ACCOUNT = "oauth-access-token";
const KEYUTILS_DESC = `keyring:${ACCOUNT}@${SERVICE}`;
const OAUTH_BASE = "https://clerk.clerk.com";
const OAUTH_CLIENT_ID = "x7Fzlnxuu5I6UUa4"; // public client id compiled into the CLI
const EXPIRY_SKEW_MS = 30_000;

interface Session { accessToken: string; refreshToken: string; expiresAt: number; tokenType: string }
interface ClerkConfig { auth?: { production?: { userId?: string } } }

function configPath(env: Env): string {
  return env.vars["CLERK_CONFIG_DIR"] ? path.join(env.vars["CLERK_CONFIG_DIR"], "config.json") : path.join(env.xdgConfigHome, SERVICE, "config.json");
}
function fallbackPath(env: Env): string {
  return env.vars["CLERK_CONFIG_DIR"] ? path.join(env.vars["CLERK_CONFIG_DIR"], "credentials") : path.join(env.xdgDataHome, SERVICE, "credentials");
}

function parseSession(text: string): Session | null {
  try {
    const s = JSON.parse(text) as Partial<Session>;
    return typeof s.accessToken === "string" && typeof s.refreshToken === "string" ? (s as Session) : null;
  } catch { return null; }
}

type Backend = "secret-service" | "keyutils" | "macos" | "file";

/** Keyring access through the platform's CLI tools; the session value is passed via stdin/stdout, never argv. */
class ClerkStore implements LiveStore {
  constructor(private readonly env: Env) {}

  private run(cmd: string, args: string[], input?: string): Promise<RunResult> {
    return this.env.run(cmd, args, { stdio: "pipe", timeoutMs: 10_000, ...(input !== undefined ? { input } : {}) })
      .catch((e: NodeJS.ErrnoException) => ({ code: e.code === "ENOENT" ? 127 : 1, stdout: "", stderr: e.message }));
  }

  /** Backends in the order the CLI's keyring library tries them on this platform. */
  private backends(): Backend[] {
    if (process.platform === "darwin") return ["macos", "file"];
    if (process.platform === "linux") return ["secret-service", "keyutils", "file"];
    return ["file"];
  }

  private async readFrom(b: Backend): Promise<string | null> {
    switch (b) {
      case "secret-service": {
        const r = await this.run("secret-tool", ["lookup", "service", SERVICE, "username", ACCOUNT]);
        return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
      }
      case "keyutils": {
        const id = await this.findKey();
        if (!id) return null;
        const r = await this.run("keyctl", ["print", id]);
        return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
      }
      case "macos": {
        const r = await this.run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
        return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
      }
      case "file": {
        try { return (await fs.readFile(fallbackPath(this.env), "utf8")).trim() || null; } catch { return null; }
      }
    }
  }

  private async writeTo(b: Backend, value: string): Promise<boolean> {
    switch (b) {
      case "secret-service":
        return (await this.run("secret-tool", ["store", "--label", "Clerk CLI session (acctx)", "service", SERVICE, "username", ACCOUNT], value)).code === 0;
      case "keyutils": {
        await this.clearFrom("keyutils");
        // Add to the user keyring (@u). Adding to @s from a child process would
        // create a throwaway session keyring that dies with the child.
        const r = await this.run("keyctl", ["padd", "user", KEYUTILS_DESC, "@u"], value);
        return r.code === 0;
      }
      case "macos":
        return (await this.run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", value])).code === 0;
      case "file":
        await writeAtomic(fallbackPath(this.env), value + "\n", 0o600);
        return true;
    }
  }

  private async clearFrom(b: Backend): Promise<void> {
    switch (b) {
      case "secret-service": await this.run("secret-tool", ["clear", "service", SERVICE, "username", ACCOUNT]); return;
      case "keyutils": {
        for (let i = 0; i < 5; i++) {
          const id = await this.findKey();
          if (!id) return;
          await this.run("keyctl", ["unlink", id, "@u"]);
          await this.run("keyctl", ["unlink", id, "@s"]);
          await this.run("keyctl", ["revoke", id]);
        }
        return;
      }
      case "macos": await this.run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]); return;
      case "file": await removeIfExists(fallbackPath(this.env)); return;
    }
  }

  /** Kernel key id for the Clerk entry, searching the session chain then the user keyring. */
  private async findKey(): Promise<string | null> {
    for (const ring of ["@s", "@u"]) {
      const r = await this.run("keyctl", ["search", ring, "user", KEYUTILS_DESC]);
      if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    return null;
  }

  /** The backend currently holding a session, else the first usable one. */
  async activeBackend(): Promise<Backend | null> {
    for (const b of this.backends()) if (await this.readFrom(b)) return b;
    return null;
  }

  async readSession(): Promise<string | null> {
    for (const b of this.backends()) { const v = await this.readFrom(b); if (v) return v; }
    return null;
  }

  async exists(): Promise<boolean> { return (await this.readSession()) !== null; }

  async read(): Promise<Record<string, Buffer>> {
    const out: Record<string, Buffer> = {};
    const session = await this.readSession();
    if (session) out["session.json"] = Buffer.from(session + "\n");
    const cfg = configPath(this.env);
    if (exists(cfg)) out["config.json"] = await fs.readFile(cfg);
    return out;
  }

  async write(entries: Record<string, Buffer | null>): Promise<void> {
    if ("session.json" in entries) {
      const value = entries["session.json"];
      if (value === null || value === undefined) {
        for (const b of this.backends()) await this.clearFrom(b);
      } else {
        const text = value.toString("utf8").trim();
        let stored = false;
        for (const b of this.backends()) {
          if (b === "file") continue;
          if (await this.writeTo(b, text)) { stored = true; await this.clearFrom("file"); break; }
        }
        if (!stored) await this.writeTo("file", text);
      }
    }
    if ("config.json" in entries) {
      const value = entries["config.json"];
      if (value === null || value === undefined) await removeIfExists(configPath(this.env));
      else await writeAtomic(configPath(this.env), value, 0o600);
    }
  }
}

async function refreshIfNeeded(dir: string, env: Env): Promise<{ session: Session | null; reason?: string }> {
  const text = await fs.readFile(path.join(dir, "session.json"), "utf8").catch(() => "");
  const session = parseSession(text);
  if (!session) return { session: null, reason: "session.json is missing or malformed" };
  if (!(session.expiresAt <= Date.now() + EXPIRY_SKEW_MS)) return { session };
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: OAUTH_CLIENT_ID });
  const res = await env.fetch(new URL("/oauth/token", OAUTH_BASE), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!res.ok) return { session: null, reason: `session expired and refresh was refused (HTTP ${res.status}); run: acctx add clerk <name>` };
  const tok = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string };
  if (!tok.access_token || !tok.refresh_token) return { session: null, reason: "refresh response had no tokens" };
  const next: Session = { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000, tokenType: tok.token_type ?? "Bearer" };
  await writeAtomic(path.join(dir, "session.json"), JSON.stringify(next) + "\n", 0o600);
  return { session: next };
}

async function userinfo(dir: string, env: Env): Promise<{ email?: string; sub?: string } | { error: string }> {
  try {
    const { session, reason } = await refreshIfNeeded(dir, env);
    if (!session) return { error: reason ?? "no session" };
    const res = await env.fetch(new URL("/oauth/userinfo", OAUTH_BASE), { headers: { Authorization: `Bearer ${session.accessToken}` } });
    if (!res.ok) return { error: `token rejected (HTTP ${res.status})` };
    return (await res.json()) as { email?: string; sub?: string };
  } catch (e) {
    return { error: `could not reach clerk.clerk.com (${(e as Error).message})` };
  }
}

export const clerk: Provider = {
  id: "clerk",
  displayName: "Clerk",
  installHint: "npm i -g clerk  (or bun add -g clerk)",
  loginMode: "in-place",
  storage: {
    summary: "The Clerk CLI keeps its OAuth session (access + refresh token) in the OS keyring, with a plain credentials file only as a fallback; config.json holds the user id and preferences.",
    location: "keyring entry clerk-cli/oauth-access-token (Linux: secret service or kernel keyutils; macOS: Keychain), fallback $XDG_DATA_HOME/clerk-cli/credentials; config at $XDG_CONFIG_HOME/clerk-cli/config.json",
    login: "`clerk auth login` has no isolated mode (it always writes the keyring), so the current session is stashed into its profile first and the CLI logs in in place.",
    identity: "Offline: userId in config.json (mismatch fingerprint). Online: Clerk's OAuth userinfo endpoint with the profile's access token, refreshing it first if expired; refreshed sessions are written back.",
    overrideEnv: ["CLERK_PLATFORM_API_KEY"],
    caveats: [
      "Sessions stored in the kernel keyring (keyutils) vanish at reboot or logout; acctx profiles keep a copy on disk at 0600, which is less volatile than the CLI's own storage. Remove profiles you no longer need.",
      "Keyring access goes through the platform tools keyctl, secret-tool or security; they must be on PATH for acctx to read or write the live session.",
      "CLERK_CONFIG_DIR relocates config.json and the fallback file but not the keyring entry.",
    ],
    verified: "Linux (WSL2, kernel keyutils backend), clerk 3.1: import, use, check, list. The secret-service and macOS Keychain paths follow the library's conventions but were not exercised; in-place login flow not run.",
  },
  files(env) {
    return [
      { name: "session.json", path: "keyring://clerk-cli/oauth-access-token", required: true, mode: 0o600, virtual: true },
      { name: "config.json", path: configPath(env), required: false, mode: 0o600 },
    ];
  },
  liveStore: (env) => new ClerkStore(env),

  async loginInPlace(env) {
    const res = await env.run("clerk", ["auth", "login"], { stdio: "inherit", env: withoutOverrides(clerk) }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new UserError("The `clerk` CLI is not installed or not on PATH.", `Install it: ${clerk.installHint}`);
      throw e;
    });
    if (res.code !== 0) throw new UserError("Clerk login failed or was cancelled.", "Your previous login is still saved in its profile.");
  },

  async fingerprint(paths) {
    const cfg = paths["config.json"] ? await readJson<ClerkConfig>(paths["config.json"]) : null;
    return cfg?.auth?.production?.userId ?? null;
  },

  async identify(dir, env): Promise<Identity | null> {
    const info = await userinfo(dir, env);
    if ("error" in info) return null;
    const label = info.email ?? info.sub;
    return label ? { label, details: info.sub ? { userId: info.sub } : {} } : null;
  },

  async verify(dir, env): Promise<VerifyResult> {
    const info = await userinfo(dir, env);
    if ("error" in info) return { ok: false, reason: info.error };
    return { ok: true, label: info.email ?? info.sub ?? "" };
  },
};

export const _internal = { ClerkStore, parseSession, KEYUTILS_DESC };
