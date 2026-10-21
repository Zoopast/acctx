import path from "node:path";
import { UserError } from "../core/errors.js";
import type { Env } from "../core/env.js";
import { readJson } from "../core/fsx.js";
import { withoutOverrides, type Provider, type Identity, type VerifyResult } from "./types.js";

const TEAMS_URL = "https://api.convex.dev/api/dashboard/teams";

interface ConvexConfig { accessToken?: string }
interface ConvexTeam { id?: number; name?: string; slug?: string }

/**
 * The Convex CLI has no whoami, so the only way to label or validate a login
 * is one read-only call to Convex's own API listing the account's teams.
 */
async function teams(dir: string, env: Env): Promise<{ status: number; teams: ConvexTeam[] }> {
  const cfg = await readJson<ConvexConfig>(path.join(dir, "config.json"));
  if (!cfg?.accessToken) return { status: 0, teams: [] };
  const res = await env.fetch(TEAMS_URL, { headers: { Authorization: `Bearer ${cfg.accessToken}`, "Convex-Client": "acctx-0.1.0" } });
  if (!res.ok) return { status: res.status, teams: [] };
  const body = (await res.json()) as unknown;
  return { status: res.status, teams: Array.isArray(body) ? (body as ConvexTeam[]) : [] };
}

/**
 * Convex stores a single ~/.convex/config.json = { accessToken }. Its CLI has
 * no config-dir flag, so new logins happen in place: acctx stashes the current
 * login into its profile first, then runs `npx convex login`.
 */
export const convex: Provider = {
  id: "convex",
  displayName: "Convex",
  installHint: "npm i -g convex  (or use npx convex)",
  loginMode: "in-place",
  storage: {
    summary: "The Convex CLI stores one account access token in a small JSON file.",
    location: "$HOME/.convex/config.json",
    login: "`npx convex login` has no config-dir option, so the current login is stashed into its profile first and the CLI logs in in place.",
    identity: "No whoami exists, so acctx makes one read-only request to api.convex.dev listing the account's teams, with the profile's token. No offline fingerprint.",
    overrideEnv: ["CONVEX_DEPLOY_KEY"],
    caveats: [
      "Without an offline fingerprint, acctx cannot detect a `npx convex login` made outside acctx; always add Convex accounts through `acctx add convex`.",
      "Project directories keep their own deployment selection (.env.local); switching accounts does not change which deployment a project points at.",
    ],
    verified: "Linux, convex 1.47: add (second account), import, use, check, list; tokens validated against the Convex API.",
  },

  files(env: Env) {
    return [{ name: "config.json", path: path.join(env.home, ".convex", "config.json"), required: true, mode: 0o600 }];
  },

  async loginInPlace(env) {
    const res = await env.run("npx", ["convex", "login"], { stdio: "inherit", env: withoutOverrides(convex) }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new UserError("`npx` was not found on PATH.", `Install Node.js, then: ${convex.installHint}`);
      throw e;
    });
    if (res.code !== 0) throw new UserError("Convex login failed or was cancelled.", "Your previous login is still saved in its profile.");
  },

  async identify(dir, env): Promise<Identity | null> {
    try {
      const { status, teams: list } = await teams(dir, env);
      if (status !== 200 || list.length === 0) return null;
      const names = list.map((t) => t.name ?? t.slug ?? "").filter(Boolean);
      const first = names[0] ?? "convex";
      return { label: names.length > 1 ? `${first} +${names.length - 1}` : first, details: { teams: names.join(", ") } };
    } catch {
      return null; // offline: the profile is still usable, just unlabeled
    }
  },

  async verify(dir, env): Promise<VerifyResult> {
    try {
      const { status, teams: list } = await teams(dir, env);
      if (status === 200) return { ok: true, label: list.map((t) => t.name ?? t.slug).filter(Boolean).join(", ") };
      if (status === 0) return { ok: false, reason: "config.json has no accessToken" };
      if (status === 401 || status === 403) return { ok: false, reason: `token rejected (HTTP ${status}); log in again with: acctx add convex <name>` };
      return { ok: false, reason: `unexpected HTTP ${status}` };
    } catch (e) {
      return { ok: false, reason: `could not reach api.convex.dev (${(e as Error).message})` };
    }
  },
};
