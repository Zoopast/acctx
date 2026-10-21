import type { Context } from "../cli.js";
import type { Provider } from "../providers/types.js";
import { UserError } from "../core/errors.js";
import { sym } from "../core/ui.js";
import { loadProject, type ProjectConfig } from "../core/project.js";
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
  const project = await requireProject(ctx, reg);
  if (project.entries.length === 0) throw new UserError(`${project.file} lists no providers.`, "Run: acctx init --force");
  const entries = await projectStatus(ctx.store, ctx.switcher, reg, project);
  const ok = entries.every((e) => e.state === "ok");
  if (ctx.flags["json"]) ctx.ui.out(JSON.stringify({ file: project.file, ok, entries }, null, 2));
  else printStatus(ctx, project, entries);
  return ok ? 0 : 1;
}

export async function useProject(ctx: Context, reg: Registry, project: ProjectConfig): Promise<number> {
  const { ui } = ctx;
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
