import path from "node:path";
import fs from "node:fs/promises";
import { UserError } from "../core/errors.js";
import type { Env } from "../core/env.js";
import { withoutOverrides, type Provider, type Identity, type VerifyResult } from "./types.js";

async function readToken(dir: string): Promise<string | null> {
  try { return (await fs.readFile(path.join(dir, "access-token"), "utf8")).trim() || null; } catch { return null; }
}

interface Whoami { id?: string; email?: string; username?: string }

async function whoami(dir: string, env: Env): Promise<{ code: number; who: Whoami | null; err: string }> {
  const token = await readToken(dir);
  if (!token) return { code: 1, who: null, err: "access-token file is empty" };
  // Token goes through the child's environment, never argv.
  const res = await env.run("supabase", ["whoami", "--output-format", "json"], {
    stdio: "pipe", timeoutMs: 20_000, env: { ...withoutOverrides(supabase), SUPABASE_ACCESS_TOKEN: token },
  }).catch((e: NodeJS.ErrnoException) => ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? "supabase CLI not found" : e.message }));
  const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  let who: Whoami | null = null;
  if (line) { try { who = JSON.parse(line) as Whoami; } catch { who = null; } }
  const err = (res.stderr + "\n" + res.stdout).split("\n").map((l) => l.trim()).filter((l) => l && !/new version|recommend updating/i.test(l))[0] ?? "";
  return { code: res.code, who, err };
}

export const supabase: Provider = {
  id: "supabase",
  displayName: "Supabase",
  installHint: "https://supabase.com/docs/guides/cli (supabase)",
  loginMode: "in-place",
  storage: {
    summary: "The Supabase CLI writes the personal access token as a raw string to a single file.",
    location: "$HOME/.supabase/access-token",
    login: "`supabase login` has no config-dir option, so the current login is stashed into its profile first and the CLI logs in in place.",
    identity: "`supabase whoami` run with the profile's token passed as SUPABASE_ACCESS_TOKEN in the child environment (never as an argument).",
    overrideEnv: ["SUPABASE_ACCESS_TOKEN"],
    caveats: [
      "Where an OS keyring is available the CLI may store the token there instead of the file; then acctx sees no login. Use `supabase login --token` or a machine without a keyring daemon.",
      "telemetry.json and cli-latest in the same directory are not part of the login and are left alone.",
    ],
    verified: "Linux, supabase 2.120: import, check, list, use (cloned profile). In-place login flow not exercised.",
  },

  files(env) {
    return [{ name: "access-token", path: path.join(env.home, ".supabase", "access-token"), required: true, mode: 0o600 }];
  },

  async loginInPlace(env) {
    const res = await env.run("supabase", ["login"], { stdio: "inherit", env: withoutOverrides(supabase) }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new UserError("The `supabase` CLI is not installed or not on PATH.", `Install it: ${supabase.installHint}`);
      throw e;
    });
    if (res.code !== 0) throw new UserError("Supabase login failed or was cancelled.", "Your previous login is still saved in its profile.");
  },

  async identify(dir, env): Promise<Identity | null> {
    const { who } = await whoami(dir, env);
    if (!who) return null;
    const label = who.email ?? who.username ?? who.id;
    if (!label) return null;
    const details: Record<string, string> = {};
    if (who.username) details["username"] = who.username;
    return { label, details };
  },

  async verify(dir, env): Promise<VerifyResult> {
    const { code, who, err } = await whoami(dir, env);
    if (code === 0 && who) return { ok: true, label: who.email ?? who.username ?? "" };
    return { ok: false, reason: err || `supabase exited ${code}` };
  },
};
