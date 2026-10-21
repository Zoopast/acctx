import path from "node:path";
import { readJson, writeAtomic, removeIfExists } from "../core/fsx.js";
import { UserError } from "../core/errors.js";
import type { Env } from "../core/env.js";
import type { Provider, Identity, VerifyResult } from "./types.js";

/** Shape of auth.json; only non-secret fields are read. */
interface VercelAuth { userId?: string }
interface VercelConfig { currentTeam?: string }

export const vercel: Provider = {
  id: "vercel",
  displayName: "Vercel",
  installHint: "npm i -g vercel@latest",
  loginMode: "isolated",

  files(env: Env) {
    const dir = path.join(env.xdgDataHome, "com.vercel.cli");
    return [
      { name: "auth.json", path: path.join(dir, "auth.json"), required: true, mode: 0o600 },
      { name: "config.json", path: path.join(dir, "config.json"), required: false, mode: 0o600 },
    ];
  },

  async seedScratch(dir) {
    // An empty auth object makes the CLI start a fresh device-code login
    // instead of reusing anything from the default location.
    await writeAtomic(path.join(dir, "auth.json"), "{}\n", 0o600);
  },

  async loginIsolated(dir, env) {
    const res = await env.run("vercel", ["login", "--global-config", dir], { stdio: "inherit" }).catch(missingCli);
    if (res.code !== 0) throw new UserError("Vercel login failed or was cancelled.", "Nothing was saved.");
  },

  async fingerprint(paths) {
    const auth = paths["auth.json"] ? await readJson<VercelAuth>(paths["auth.json"]) : null;
    return auth?.userId ?? null;
  },

  async verify(dir, env): Promise<VerifyResult> {
    const res = await env
      .run("vercel", ["whoami", "--global-config", dir, "--non-interactive"], {
        stdio: "pipe", env: { VERCEL_TELEMETRY_DISABLED: "1" }, timeoutMs: 20_000,
      })
      .catch((e: NodeJS.ErrnoException) => ({ code: -1, stdout: "", stderr: e.code === "ENOENT" ? "vercel CLI not found" : e.message }));
    for (const junk of ["telemetry-device.json", "telemetry-session.json"]) await removeIfExists(path.join(dir, junk));
    if (res.code === 0) return { ok: true, label: lastNonEmptyLine(res.stdout) ?? "" };
    const reason = lastNonEmptyLine(res.stderr + "\n" + res.stdout) ?? `exit ${res.code}`;
    return { ok: false, reason: reason.replace(/^Error:\s*/, "") };
  },

  async identify(dir, env): Promise<Identity | null> {
    const auth = await readJson<VercelAuth>(path.join(dir, "auth.json"));
    const cfg = await readJson<VercelConfig>(path.join(dir, "config.json"));
    const details: Record<string, string> = {};
    if (auth?.userId) details["userId"] = auth.userId;
    if (cfg?.currentTeam) details["team"] = cfg.currentTeam;
    // Non-interactive so a dead token fails fast instead of starting a login
    // flow; telemetry off so nothing extra is written into the profile dir.
    // Note: this may refresh the token inside `dir`, which is why callers
    // treat `dir` as authoritative afterwards.
    const res = await env
      .run("vercel", ["whoami", "--global-config", dir, "--non-interactive"], {
        stdio: "pipe",
        env: { VERCEL_TELEMETRY_DISABLED: "1" },
        timeoutMs: 20_000,
      })
      .catch(() => ({ code: 1, stdout: "", stderr: "" }));
    // The CLI writes telemetry files even when telemetry is disabled; keep the profile dir clean.
    for (const junk of ["telemetry-device.json", "telemetry-session.json"]) await removeIfExists(path.join(dir, junk));
    const username = res.code === 0 ? lastNonEmptyLine(res.stdout) : undefined;
    const label = username ?? auth?.userId;
    return label ? { label, details } : null;
  },
};

function lastNonEmptyLine(s: string): string | undefined {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.at(-1);
}

function missingCli(e: NodeJS.ErrnoException): never {
  if (e.code === "ENOENT") throw new UserError("The `vercel` CLI is not installed or not on PATH.", `Install it with: ${vercel.installHint}`);
  throw e;
}
