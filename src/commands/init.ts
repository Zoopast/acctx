import path from "node:path";
import type { Context } from "../cli.js";
import { UserError } from "../core/errors.js";
import { exists, writeAtomic } from "../core/fsx.js";
import { PROJECT_FILE, type Selector } from "../core/project.js";
import type { ProfileMeta } from "../core/store.js";
import type { Registry } from "./project.js";

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
  const w = Math.max(...Object.keys(body).map((id) => id.length));
  for (const [id, sel] of Object.entries(body)) ui.out(`  ${ui.s.cyan(id.padEnd(w))}  ${typeof sel === "string" ? `profile ${sel}` : Object.entries(sel).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  ui.hint("Commit it (it holds no secrets). Check it any time with: acctx status");
  if (installSkill && ctx.flags["yes"]) await installSkill("project");
  else if (installSkill && ctx.interactive) {
    const scope = await ui.select("Install the acctx skill for AI agents?", ["project", "global", "skip"], (x) => x);
    if (scope === "project" || scope === "global") await installSkill(scope);
  }
  return 0;
}
