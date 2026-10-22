import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "../cli.js";
import { UserError } from "../core/errors.js";
import { ensureDir, exists, writeAtomic } from "../core/fsx.js";
import { DEFAULT_AGENTS, mergeGuardHook, skillSourcePath, skillTargets } from "../core/skillfile.js";

export interface InstallSkillOptions {
  agents?: string[];
  hook?: boolean;
  /** Overwrite a differing file without asking. */
  force?: boolean;
  /** When a target differs and cannot be confirmed, keep it (warn) instead of failing. Used by `acctx init`. */
  keepExisting?: boolean;
}

export async function installSkill(ctx: Context, scope: "project" | "global", opts: InstallSkillOptions = {}): Promise<void> {
  const { ui } = ctx;
  const home = ctx.switcher.env.home;
  const source = await fs.readFile(skillSourcePath(), "utf8");
  const targets = skillTargets(opts.agents ?? DEFAULT_AGENTS, scope, ctx.cwd, home);
  if (scope === "global" && !ctx.flags["yes"]) {
    if (!ctx.interactive) throw new UserError("Installing globally writes under your home directory; confirm with --yes.", `Targets:\n${targets.map((t) => "  " + t).join("\n")}`);
    ui.info(`This writes:\n${targets.map((t) => "  " + t).join("\n")}`);
    if (!(await ui.confirm("Install the acctx skill globally?", true))) { ui.info("Skipped."); return; }
  }
  // Validate settings.json before touching any file, so a bad one cannot leave a partial install.
  const settings = path.join(scope === "project" ? ctx.cwd : home, ".claude", "settings.json");
  const merged = opts.hook ? mergeGuardHook(exists(settings) ? await fs.readFile(settings, "utf8") : null) : null;
  for (const target of targets) {
    if (exists(target)) {
      const current = await fs.readFile(target, "utf8");
      if (current === source) { ui.info(`${target} is up to date.`); continue; }
      if (!opts.force) {
        if (!ctx.interactive) {
          if (opts.keepExisting) { ui.warn(`${target} differs from the packaged skill; kept. Update it with: acctx skill install --force`); continue; }
          throw new UserError(`${target} exists and differs from the packaged skill; overwrite it with --force.`);
        }
        if (!(await ui.confirm(`${target} differs. Overwrite?`, false))) { ui.info("Kept."); continue; }
      }
    }
    await ensureDir(path.dirname(target), 0o755);
    await writeAtomic(target, source, 0o644);
    ui.success(`Installed ${target}`);
  }
  if (merged) {
    if (!merged.changed) ui.info(`${settings} already runs acctx guard.`);
    else {
      await fs.mkdir(path.dirname(settings), { recursive: true, mode: 0o755 }); // does not chmod an existing dir
      const st = await fs.lstat(settings).catch(() => null);
      const dest = st?.isSymbolicLink()
        ? await fs.realpath(settings).catch(() => { throw new UserError(`${settings} is a symlink to a missing file.`, "Fix or remove the link, then run the install again."); })
        : settings;
      const mode = st ? (st.isSymbolicLink() ? (await fs.stat(dest)).mode : st.mode) & 0o777 : 0o644;
      await writeAtomic(dest, merged.text, mode);
      ui.success(`Added a PreToolUse hook (Bash → acctx guard) to ${settings}`);
      ui.hint("It blocks provider CLI commands when the project's accounts are not active. Remove the entry from that file to disable it.");
    }
  }
}

export async function skillCmd(ctx: Context): Promise<number> {
  const sub = ctx.args[0];
  if (sub === "show") { ctx.ui.out((await fs.readFile(skillSourcePath(), "utf8")).replace(/\n$/, "")); return 0; }
  if (sub !== "install") throw new UserError("Usage: acctx skill install [--global] [--agent a,b] [--hook] | acctx skill show");
  let agents: string[] | undefined;
  if (ctx.flags["agent"] !== undefined) {
    agents = typeof ctx.flags["agent"] === "string" ? ctx.flags["agent"].split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (agents.length === 0) throw new UserError("--agent needs a value.", "Example: --agent claude-code,cursor");
  }
  await installSkill(ctx, ctx.flags["global"] ? "global" : "project", { ...(agents ? { agents } : {}), hook: Boolean(ctx.flags["hook"]), force: Boolean(ctx.flags["force"]) });
  ctx.ui.hint("Other agents: acctx skill show, or `npx skills add Zoopast/acctx`.");
  return 0;
}
