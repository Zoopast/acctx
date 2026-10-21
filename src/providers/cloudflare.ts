import path from "node:path";
import { UserError } from "../core/errors.js";
import { withNativeLayout } from "../core/stage.js";
import type { Env, RunOptions, RunResult } from "../core/env.js";
import { withoutOverrides, type Provider, type Identity, type VerifyResult } from "./types.js";

const LAYOUT = { "default.toml": path.join(".wrangler", "config", "default.toml") };

/** Prefer a PATH wrangler; fall back to npx (slow, hence the long timeout). */
async function wrangler(env: Env, args: string[], opts: RunOptions): Promise<RunResult> {
  try {
    return await env.run("wrangler", args, opts);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return env.run("npx", ["-y", "wrangler", ...args], { ...opts, timeoutMs: opts.timeoutMs ? Math.max(opts.timeoutMs, 90_000) : undefined } as RunOptions);
  }
}

function parseWhoami(out: string): Identity | null {
  const email = /associated with the email[^\S\n]+'?([^'\s]+@[^'\s.]+(?:\.[^'\s.]+)*)/i.exec(out)?.[1];
  const apiTok = /logged in with an API Token/i.test(out);
  if (!email && !apiTok) return null;
  const accounts = [...out.matchAll(/^│\s*([^│]+?)\s*│\s*([0-9a-f]{32})\s*│/gm)].map((m) => m[1]!.trim());
  const details: Record<string, string> = {};
  if (accounts.length) details["accounts"] = accounts.join(", ");
  return { label: email ?? "api-token", details };
}

export const cloudflare: Provider = {
  id: "cloudflare",
  displayName: "Cloudflare (wrangler)",
  installHint: "npm i -g wrangler",
  loginMode: "isolated",
  layout: LAYOUT,
  storage: {
    summary: "wrangler stores an OAuth token, refresh token and expiry in a TOML file under its config root.",
    location: "$XDG_CONFIG_HOME/.wrangler/config/default.toml (default $HOME/.config/.wrangler/config/default.toml)",
    login: "`wrangler login` runs with XDG_CONFIG_HOME pointing at a scratch root that mirrors the nested layout; the result is stored flat as default.toml.",
    identity: "`wrangler whoami` against a staged copy of the profile; the email line is parsed. The token rotates, so refreshed files are written back.",
    overrideEnv: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"],
    caveats: [
      "wrangler's login opens a browser and listens on a local port; it must run on a machine with a browser or forwarded port.",
      "Logs and metrics files next to the config are not part of the login.",
    ],
    verified: "Linux, wrangler 4.151 via npx: config location under XDG_CONFIG_HOME and the logged-out whoami path. No login was performed, so add/check/use are unverified.",
  },

  files(env) {
    return [{ name: "default.toml", path: path.join(env.xdgConfigHome, ".wrangler", "config", "default.toml"), required: true, mode: 0o600 }];
  },

  async loginIsolated(dir, env) {
    const res = await withNativeLayout(dir, LAYOUT, (root) =>
      wrangler(env, ["login"], { stdio: "inherit", env: { XDG_CONFIG_HOME: root, ...withoutOverrides(cloudflare) } }),
    );
    if (res.code !== 0) throw new UserError("Cloudflare login failed or was cancelled.", "Nothing was saved.");
  },

  async identify(dir, env): Promise<Identity | null> {
    const res = await withNativeLayout(dir, LAYOUT, (root) =>
      wrangler(env, ["whoami"], { stdio: "pipe", timeoutMs: 60_000, env: { XDG_CONFIG_HOME: root, ...withoutOverrides(cloudflare) } }),
    ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    return res.code === 0 ? parseWhoami(res.stdout) : null;
  },

  async verify(dir, env): Promise<VerifyResult> {
    const res = await withNativeLayout(dir, LAYOUT, (root) =>
      wrangler(env, ["whoami"], { stdio: "pipe", timeoutMs: 60_000, env: { XDG_CONFIG_HOME: root, ...withoutOverrides(cloudflare) } }),
    ).catch((e: Error) => ({ code: -1, stdout: "", stderr: e.message }));
    const id = res.code === 0 ? parseWhoami(res.stdout) : null;
    if (id) return { ok: true, label: id.label };
    const line = (res.stdout + "\n" + res.stderr).split("\n").map((l) => l.trim()).find((l) => /not authenticated|error|invalid|expired/i.test(l));
    return { ok: false, reason: line ?? `wrangler exited ${res.code}` };
  },
};

export const _parseWhoami = parseWhoami;
