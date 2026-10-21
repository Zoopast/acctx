import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Context } from "../cli.js";
import type { Provider } from "../providers/types.js";
import { UserError } from "../core/errors.js";

interface Registry { providers: readonly Provider[]; getProvider(id: string): Provider }

export const HELP = `acctx — switch accounts for developer CLIs

Usage:
  acctx add <provider> [name]       Log into a new account and save it as a profile
  acctx import <provider> <name>    Save the account the CLI is currently logged into
  acctx use [provider] [name]       Switch to a profile (interactive picker if omitted)
  acctx list [provider]             List saved profiles
  acctx current [provider]          Show the active profile(s)
  acctx rename <provider> <old> <new>  Rename a saved profile
  acctx remove <provider> <name>    Delete a saved profile (--force if it is active)
  acctx providers                   List supported providers

Flags:
  --discard          Overwrite a live login that is not saved in any profile
  --force, -f        Skip confirmations
  --non-interactive  Never prompt
  --help, -h         Show this help

Environment:
  ACCTX_HOME   Profile store directory (default: $XDG_CONFIG_HOME/acctx)
  ACCTX_DEBUG  Print stack traces (secrets are redacted)

Profiles are copies of the provider CLI's own credential files, stored with
0600 permissions. acctx never prints tokens and makes no network calls itself.`;

export async function runCommand(cmd: string, ctx: Context, reg: Registry): Promise<number> {
  switch (cmd) {
    case "help": ctx.out(HELP); return 0;
    case "providers":
      for (const p of reg.providers) ctx.out(`${p.id.padEnd(10)} ${p.displayName}  (login: ${p.loginMode})`);
      return 0;
    case "list": return list(ctx, reg);
    case "current": return current(ctx, reg);
    case "add": return add(ctx, reg);
    case "import": return importCmd(ctx, reg);
    case "use": return use(ctx, reg);
    case "rename": case "mv": return rename(ctx, reg);
    case "remove": case "rm": return remove(ctx, reg);
    default:
      throw new UserError(`Unknown command "${cmd}".`, "Run `acctx --help` for usage.");
  }
}

function need(ctx: Context, i: number, what: string): string {
  const v = ctx.args[i];
  if (!v) throw new UserError(`Missing ${what}.`, "Run `acctx --help` for usage.");
  return v;
}

async function list(ctx: Context, reg: Registry): Promise<number> {
  const provider = ctx.args[0] ? reg.getProvider(ctx.args[0]).id : undefined;
  const profiles = await ctx.store.listProfiles(provider);
  const state = await ctx.store.readState();
  if (profiles.length === 0) {
    ctx.out(provider ? `No ${provider} profiles yet. Add one with: acctx add ${provider} <name>` : "No profiles yet. Add one with: acctx add vercel <name>");
    return 0;
  }
  const w = Math.max(...profiles.map((p) => p.name.length), 4);
  for (const p of profiles) {
    const active = state.active[p.provider] === p.name ? "*" : " ";
    const details = p.meta.identity?.details ? Object.entries(p.meta.identity.details).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    ctx.out(`${active} ${p.provider.padEnd(8)} ${p.name.padEnd(w)}  ${p.meta.label}${details ? "  " + details : ""}`);
  }
  return 0;
}

async function current(ctx: Context, reg: Registry): Promise<number> {
  const state = await ctx.store.readState();
  const ids = ctx.args[0] ? [reg.getProvider(ctx.args[0]).id] : reg.providers.map((p) => p.id);
  for (const id of ids) {
    const name = state.active[id];
    const p = reg.getProvider(id);
    const live = ctx.switcher.liveExists(p);
    if (name) ctx.out(`${id.padEnd(8)} ${name}${live ? "" : "  (live credentials missing!)"}`);
    else ctx.out(`${id.padEnd(8)} ${live ? "(logged in, not saved — run: acctx import " + id + " <name>)" : "(not logged in)"}`);
  }
  return 0;
}

async function add(ctx: Context, reg: Registry): Promise<number> {
  const p = reg.getProvider(need(ctx, 0, "provider"));
  const name = ctx.args[1];
  if (p.loginMode === "in-place") ctx.err(`Your current ${p.displayName} login will be saved to its profile, then ${p.displayName}'s own login flow starts.`);
  else ctx.err(`Starting ${p.displayName}'s login flow in an isolated directory; your current login is untouched.`);
  const res = await ctx.switcher.add(p, name, { discard: Boolean(ctx.flags["discard"]) });
  const state = await ctx.store.readState();
  ctx.out(`Saved ${p.id}/${res.name} (${res.meta.label}).`);
  if (state.active[p.id] !== res.name) ctx.out(`Activate it with: acctx use ${p.id} ${res.name}`);
  return 0;
}

async function importCmd(ctx: Context, reg: Registry): Promise<number> {
  const p = reg.getProvider(need(ctx, 0, "provider"));
  const name = need(ctx, 1, "profile name");
  const meta = await ctx.switcher.importLive(p, name);
  ctx.out(`Imported current ${p.displayName} login as ${p.id}/${name} (${meta.label}). It is now the active profile.`);
  return 0;
}

async function use(ctx: Context, reg: Registry): Promise<number> {
  let providerId = ctx.args[0];
  let name = ctx.args[1];
  if (!providerId || !name) {
    if (!ctx.interactive) throw new UserError("Usage: acctx use <provider> <name>", "Interactive selection needs a terminal.");
    const picked = await pick(ctx, providerId ? reg.getProvider(providerId).id : undefined);
    providerId = picked.provider;
    name = picked.name;
  }
  const p = reg.getProvider(providerId);
  const state = await ctx.store.readState();
  if (state.active[p.id] === name && ctx.switcher.liveExists(p)) {
    ctx.out(`${p.id}/${name} is already active.`);
    return 0;
  }
  const meta = await ctx.switcher.use(p, name, { discard: Boolean(ctx.flags["discard"]) });
  ctx.out(`Switched ${p.displayName} to ${name} (${meta.label}).`);
  return 0;
}

async function pick(ctx: Context, provider?: string): Promise<{ provider: string; name: string }> {
  const profiles = await ctx.store.listProfiles(provider);
  if (profiles.length === 0) throw new UserError("No profiles to choose from.", "Add one with: acctx add vercel <name>");
  const state = await ctx.store.readState();
  profiles.forEach((p, i) => {
    const active = state.active[p.provider] === p.name ? " (active)" : "";
    ctx.out(`  ${String(i + 1).padStart(2)}) ${p.provider}/${p.name}  ${p.meta.label}${active}`);
  });
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question("Switch to: ")).trim();
    const idx = Number(answer) - 1;
    const chosen = profiles[idx] ?? profiles.find((p) => p.name === answer || `${p.provider}/${p.name}` === answer);
    if (!chosen) throw new UserError(`No profile matches "${answer}".`);
    return { provider: chosen.provider, name: chosen.name };
  } finally {
    rl.close();
  }
}

async function rename(ctx: Context, reg: Registry): Promise<number> {
  const p = reg.getProvider(need(ctx, 0, "provider"));
  const from = need(ctx, 1, "current profile name");
  const to = need(ctx, 2, "new profile name");
  await ctx.store.renameProfile(p.id, from, to);
  ctx.out(`Renamed ${p.id}/${from} to ${p.id}/${to}.`);
  return 0;
}

async function remove(ctx: Context, reg: Registry): Promise<number> {
  const p = reg.getProvider(need(ctx, 0, "provider"));
  const name = need(ctx, 1, "profile name");
  if (!(await ctx.store.hasProfile(p.id, name))) throw new UserError(`No ${p.displayName} profile named "${name}".`);
  const state = await ctx.store.readState();
  if (state.active[p.id] === name && !ctx.flags["force"]) {
    throw new UserError(`${p.id}/${name} is the active profile.`, "Switch to another profile first, or pass --force (the live login stays as it is).");
  }
  await ctx.store.removeProfile(p.id, name);
  ctx.out(`Removed ${p.id}/${name}. Note: the token was deleted locally, not revoked; run the provider's logout if you want revocation.`);
  return 0;
}
