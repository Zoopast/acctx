import path from "node:path";
import type { Context } from "../cli.js";
import type { Provider } from "../providers/types.js";
import { UserError } from "../core/errors.js";
import { sym } from "../core/ui.js";
import { exists, writeAtomic } from "../core/fsx.js";
import { findProjectFile, loadProject, PROJECT_FILE, type ProjectConfig, type Selector } from "../core/project.js";
import type { ProfileMeta } from "../core/store.js";
import { projectStatus, formatStatusLine, type StatusEntry } from "../core/status.js";

export interface Registry { providers: readonly Provider[]; getProvider(id: string): Provider }

export async function requireProject(ctx: Context, reg: Registry): Promise<ProjectConfig> {
  const project = await loadProject(ctx.cwd, ctx.switcher.env.home, reg.providers.map((p) => p.id));
  if (!project) throw new UserError("No .acctx.json found in this project.", "Create one with: acctx init");
  return project;
}

export function printStatus(ctx: Context, project: ProjectConfig, entries: StatusEntry[]): void {
  const w = Math.max(...entries.map((e) => e.provider.length));
  for (const e of entries) ctx.ui.out(formatStatusLine(e, ctx.ui.s, w));
  const bad = entries.filter((e) => e.state !== "ok").length;
  if (bad) ctx.ui.warn(`${bad} of ${entries.length} account(s) not ready (${project.file}).`);
}

export async function statusCmd(ctx: Context, reg: Registry): Promise<number> {
  let project: ProjectConfig | null = null;
  try {
    project = await requireProject(ctx, reg);
    if (project.entries.length === 0) throw new UserError(`${project.file} lists no providers.`, "Run: acctx init --force");
  } catch (e) {
    if (!(e instanceof UserError) || !ctx.flags["json"]) throw e;
    const file = project?.file ?? (await findProjectFile(ctx.cwd, ctx.switcher.env.home).catch(() => null));
    ctx.ui.out(JSON.stringify({ file, ok: false, error: e.message, hint: e.hint ?? null }, null, 2));
    return 1;
  }
  const entries = await projectStatus(ctx.store, ctx.switcher, reg, project);
  const ok = entries.every((e) => e.state === "ok");
  if (ctx.flags["json"]) ctx.ui.out(JSON.stringify({ file: project.file, ok, entries }, null, 2));
  else printStatus(ctx, project, entries);
  return ok ? 0 : 1;
}

export async function useProject(ctx: Context, reg: Registry, project: ProjectConfig): Promise<number> {
  const { ui } = ctx;
  if (project.entries.length === 0) throw new UserError(`${project.file} lists no providers.`, "Run: acctx init --force");
  const entries = await projectStatus(ctx.store, ctx.switcher, reg, project);
  const state = await ctx.store.readState();
  const todo = entries.filter((e) => e.state === "inactive" || e.state === "logged-out");
  const blocked = entries.filter((e) => !["ok", "inactive", "logged-out"].includes(e.state));
  if (blocked.length) printStatus(ctx, project, blocked);
  if (todo.length === 0) {
    if (!blocked.length) ui.info(`Everything in ${project.file} is already active; nothing to do.`);
    return blocked.length ? 1 : 0;
  }
  const w = Math.max(...todo.map((e) => e.provider.length));
  for (const e of todo) ui.info(`${ui.s.cyan(e.provider.padEnd(w))}  ${state.active[e.provider] ?? ui.s.dim("none")} ${sym.arrow} ${ui.s.bold(e.profile!)} ${ui.s.dim(`(${e.label})`)}`);
  let failed = 0;
  for (const e of todo) {
    const p = reg.getProvider(e.provider);
    try {
      const meta = await ctx.switcher.use(p, e.profile!, { discard: Boolean(ctx.flags["discard"]) });
      ui.success(`${p.displayName} ${sym.arrow} ${ui.s.bold(e.profile!)} ${ui.s.dim(`(${meta.label})`)}`);
    } catch (err) {
      failed++;
      if (err instanceof UserError) ui.error(`${p.displayName}: ${err.message}`, err.hint);
      else throw err;
    }
  }
  if (failed || blocked.length) ui.warn(`${failed + blocked.length} of ${entries.length} account(s) not applied.`);
  return failed || blocked.length ? 1 : 0;
}

const SKIP = Symbol("skip");

function selectorFor(name: string, meta: ProfileMeta, shared: boolean, ui: Context["ui"], providerId: string): string | Selector {
  if (!shared) return name;
  const label = meta.identity?.label;
  if (label) return { account: label };
  ui.warn(`${providerId}/${name} has no stored identity; wrote its local name instead (teammates will need to adapt it).`);
  return name;
}

export async function writeProjectFile(file: string, body: Record<string, string | Selector>): Promise<void> {
  await writeAtomic(file, JSON.stringify(body, null, 2) + "\n", 0o644);
}

export async function initCmd(ctx: Context, reg: Registry, installSkill?: (scope: "project" | "global") => Promise<void>): Promise<number> {
  const { ui } = ctx;
  const file = path.join(ctx.cwd, PROJECT_FILE);
  if (exists(file) && !ctx.flags["force"]) throw new UserError(`${file} already exists; overwrite it with: acctx init --force`);
  let shared = Boolean(ctx.flags["shared"]);
  const fromActive = Boolean(ctx.flags["from-active"]);
  if (!fromActive && !ctx.interactive) throw new UserError("acctx init needs a terminal to pick profiles.", "Or write the active ones without prompts: acctx init --from-active");
  const state = await ctx.store.readState();
  const body: Record<string, string | Selector> = {};
  if (fromActive) {
    for (const p of reg.providers) {
      const name = state.active[p.id];
      if (!name) continue;
      const meta = await ctx.store.readMeta(p.id, name);
      if (meta) body[p.id] = selectorFor(name, meta, shared, ui, p.id);
      else ui.warn(`${p.id}: active profile "${name}" has unreadable metadata; skipped.`);
    }
    if (Object.keys(body).length === 0) throw new UserError("No active profiles to write.", "Switch to the accounts this project uses first: acctx use <provider> <name>");
  } else {
    if (!ctx.flags["shared"]) {
      const who = await ui.select("Who will use this file?", ["just me (pin by profile name)", "my team (pin by account)"], (x) => x);
      if (who === null) { ui.info("Cancelled."); return 0; }
      shared = who.startsWith("my team");
    }
    for (const p of reg.providers) {
      const profiles = await ctx.store.listProfiles(p.id);
      if (profiles.length === 0) { ui.info(`${p.id}: no profiles, skipped.`); continue; }
      const items: Array<typeof profiles[number] | typeof SKIP> = [...profiles, SKIP];
      const picked = await ui.select(`${p.displayName} account for this project`, items, (x) => x === SKIP ? ui.s.dim("skip") : `${x.name}  ${ui.s.dim(x.meta.label)}${state.active[p.id] === x.name ? ui.s.green("  active") : ""}`);
      if (picked === null) { ui.info("Cancelled."); return 0; }
      if (picked === SKIP) continue;
      body[p.id] = selectorFor(picked.name, picked.meta, shared, ui, p.id);
    }
    if (Object.keys(body).length === 0) throw new UserError("Nothing selected; no file written.");
  }
  await writeProjectFile(file, body);
  ui.success(`Wrote ${ui.s.bold(file)}`);
  for (const [id, sel] of Object.entries(body)) ui.out(`  ${ui.s.cyan(id)}  ${typeof sel === "string" ? `profile ${sel}` : Object.entries(sel).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  ui.hint("Commit it (it holds no secrets). Check it any time with: acctx status");
  if (installSkill && ctx.flags["yes"]) await installSkill("project");
  else if (installSkill && ctx.interactive) {
    const scope = await ui.select("Install the acctx skill for AI agents?", ["project", "global", "skip"], (x) => x);
    if (scope === "project" || scope === "global") await installSkill(scope);
  }
  return 0;
}
