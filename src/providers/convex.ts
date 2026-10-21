import path from "node:path";
import { UserError } from "../core/errors.js";
import type { Env } from "../core/env.js";
import type { Provider, Identity } from "./types.js";

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

  files(env: Env) {
    return [{ name: "config.json", path: path.join(env.home, ".convex", "config.json"), required: true, mode: 0o600 }];
  },

  async loginInPlace(env) {
    const res = await env.run("npx", ["convex", "login"], { stdio: "inherit" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new UserError("`npx` was not found on PATH.", `Install Node.js, then: ${convex.installHint}`);
      throw e;
    });
    if (res.code !== 0) throw new UserError("Convex login failed or was cancelled.", "Your previous login is still saved in its profile.");
  },

  async identify(_dir, _env): Promise<Identity | null> {
    // The Convex CLI exposes no offline "whoami" and the token is the only
    // field in the file, so there is nothing safe to label from. The user
    // names the profile instead.
    return null;
  },
};
