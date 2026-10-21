import type { Context } from "../cli.js";
import type { Provider } from "../providers/types.js";
import { UserError } from "../core/errors.js";
import { formatList, formatListJson } from "../core/format.js";
import { sym, type Ui } from "../core/ui.js";

interface Registry { providers: readonly Provider[]; getProvider(id: string): Provider }

const COMMANDS: Array<[string, string, string]> = [
  ["add <provider> [name]", "Log into a new account and save it as a profile", ""],
  ["import <provider> <name>", "Save the account the CLI is currently logged into", ""],
  ["use [provider] [name]", "Switch to a profile (interactive picker if omitted)", "--discard"],
  ["list [provider]", "List saved profiles", "--json"],
  ["current [provider]", "Show the active profile(s)", ""],
  ["check [provider] [name]", "Verify saved logins are still valid, without switching", ""],
  ["rename <provider> <old> <new>", "Rename a saved profile", ""],
  ["remove <provider> <name>", "Delete a saved profile", "--force"],
  ["providers [id]", "Supported providers and how each one stores its login", ""],
];

export function helpText(ui: Ui): string {
  const { s } = ui;
  const w = Math.max(...COMMANDS.map(([c]) => c.length));
  const lines = [
    `${s.bold("acctx")} ${s.dim("— switch accounts for developer CLIs")}`,
    "",
    s.bold("Usage"),
    `  acctx ${s.cyan("<command>")} [arguments] [flags]`,
    "",
    s.bold("Commands"),
    ...COMMANDS.map(([c, d, f]) => `  ${s.cyan(c.padEnd(w))}  ${d}${f ? s.dim("  " + f) : ""}`),
    "",
    s.bold("Flags"),
    `  ${s.cyan("--discard".padEnd(w))}  Overwrite a live login that is not saved in any profile`,
    `  ${s.cyan("--force, -f".padEnd(w))}  Skip confirmations and safety checks`,
    `  ${s.cyan("--json".padEnd(w))}  Machine-readable output (list, providers)`,
    `  ${s.cyan("--non-interactive".padEnd(w))}  Never prompt`,
    `  ${s.cyan("--help, -h".padEnd(w))}  Show this help · ${s.cyan("--version")}`,
    "",
    s.bold("Environment"),
    `  ${s.cyan("ACCTX_HOME".padEnd(w))}  Profile store (default $XDG_CONFIG_HOME/acctx)`,
    `  ${s.cyan("ACCTX_DEBUG".padEnd(w))}  Print stack traces (secrets are redacted)`,
    "",
    s.dim("Profiles are copies of each CLI's own credential files, stored with 0600 permissions."),
    s.dim("acctx never prints tokens. Run `acctx providers <id>` to see exactly what is stored."),
  ];
  return lines.join("\n");
}

export async function runCommand(cmd: string, ctx: Context, reg: Registry): Promise<number> {
  switch (cmd) {
    case "help": ctx.ui.out(helpText(ctx.ui)); return 0;
    case "providers": case "provider": return providersCmd(ctx, reg);
    case "list": case "ls": return list(ctx, reg);
    case "current": return current(ctx, reg);
    case "add": case "login": return add(ctx, reg);
    case "import": case "save": return importCmd(ctx, reg);
    case "use": case "switch": return use(ctx, reg);
    case "check": case "verify": return check(ctx, reg);
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

function warnOverrides(ctx: Context, p: Provider): void {
  const set = ctx.switcher.activeOverrides(p);
  if (set.length) ctx.ui.warn(`${set.join(", ")} is set in your environment; the ${p.displayName} CLI will use it instead of the switched login.`);
}

async function providersCmd(ctx: Context, reg: Registry): Promise<number> {
  const { ui } = ctx;
  const { s } = ui;
  if (ctx.flags["json"]) {
    ui.out(JSON.stringify(reg.providers.map((p) => ({ id: p.id, displayName: p.displayName, loginMode: p.loginMode, ...p.storage, files: p.files(ctx.switcher.env).map((f) => f.path) })), null, 2));
    return 0;
  }
  if (ctx.args[0]) {
    const p = reg.getProvider(ctx.args[0]);
    const live = ctx.switcher.liveExists(p);
    const state = await ctx.store.readState();
    ui.out(`${s.bold(p.displayName)} ${s.dim(`(${p.id})`)}`);
    ui.out(`  ${p.storage.summary}`);
    ui.out("");
    ui.out(s.bold("  Stored at"));
    ui.out(`    ${s.dim(p.storage.location)}`);
    for (const f of p.files(ctx.switcher.env)) {
      ui.out(`    ${f.path}  ${s.dim(f.required ? "required" : "optional")}`);
    }
    ui.out("");
    ui.out(s.bold("  Login") + `   ${p.storage.login}`);
    ui.out(s.bold("  Identity") + ` ${p.storage.identity}`);
    if (p.storage.overrideEnv.length) ui.out(s.bold("  Env overrides") + ` ${p.storage.overrideEnv.join(", ")} ${s.dim("(if set, the CLI ignores the file)")}`);
    if (p.storage.caveats.length) {
      ui.out(s.bold("  Caveats"));
      for (const c of p.storage.caveats) ui.out(`    ${s.dim("•")} ${c}`);
    }
    ui.out(s.bold("  Verified") + ` ${s.dim(p.storage.verified)}`);
    ui.out("");
    const active = state.active[p.id];
    ui.out(s.bold("  On this machine") + ` ${live ? (active ? `logged in, active profile ${s.green(active)}` : s.yellow("logged in, not saved")) : s.dim("not logged in")}`);
    const set = ctx.switcher.activeOverrides(p);
    if (set.length) ui.out(`    ${s.yellow(sym.warn)} ${set.join(", ")} is set; the CLI will ignore the file`);
    return 0;
  }
  const w = Math.max(...reg.providers.map((p) => p.id.length));
  for (const p of reg.providers) {
    const live = ctx.switcher.liveExists(p) ? s.green(sym.active) : s.dim("○");
    ui.out(`${live} ${s.cyan(p.id.padEnd(w))}  ${p.displayName.padEnd(22)} ${s.dim(p.loginMode.padEnd(9))} ${s.dim(p.storage.location)}`);
  }
  ui.out("");
  ui.out(s.dim(`${sym.active} logged in on this machine · acctx providers <id> for details`));
  return 0;
}

async function list(ctx: Context, reg: Registry): Promise<number> {
  const provider = ctx.args[0] ? reg.getProvider(ctx.args[0]).id : undefined;
  const profiles = await ctx.store.listProfiles(provider);
  const state = await ctx.store.readState();
  if (ctx.flags["json"]) { ctx.ui.out(formatListJson(profiles, state.active)); return 0; }
  const shown = provider ? reg.providers.filter((p) => p.id === provider) : reg.providers.filter((p) => profiles.some((x) => x.provider === p.id) || ctx.switcher.liveExists(p));
  if (shown.length === 0) {
    ctx.ui.out(ctx.ui.s.dim("No profiles yet. Start with: acctx import <provider> <name>, or acctx add <provider> <name>"));
    return 0;
  }
  ctx.ui.out(formatList(profiles, state.active, { color: ctx.ui.color, providers: shown }));
  return 0;
}

async function current(ctx: Context, reg: Registry): Promise<number> {
  const { s } = ctx.ui;
  const state = await ctx.store.readState();
  const ids = ctx.args[0] ? [reg.getProvider(ctx.args[0]).id] : reg.providers.map((p) => p.id);
  const w = Math.max(...ids.map((i) => i.length));
  for (const id of ids) {
    const name = state.active[id];
    const p = reg.getProvider(id);
    const live = ctx.switcher.liveExists(p);
    let status: string;
    if (name) status = live ? `${s.green(sym.active)} ${s.bold(name)}` : `${s.red(sym.fail)} ${name} ${s.dim("(live credentials missing; run: acctx use " + id + " " + name + ")")}`;
    else status = live ? `${s.yellow(sym.warn)} ${s.yellow("logged in, not saved")} ${s.dim("→ acctx import " + id + " <name>")}` : s.dim("not logged in");
    ctx.ui.out(`${s.cyan(id.padEnd(w))}  ${status}`);
    if (name || live) warnOverrides(ctx, p);
  }
  return 0;
}

async function add(ctx: Context, reg: Registry): Promise<number> {
  const { ui } = ctx;
  const p = reg.getProvider(need(ctx, 0, "provider"));
  const name = ctx.args[1];
  if (p.loginMode === "in-place") {
    if (ctx.switcher.liveExists(p)) ui.info(`Your current ${p.displayName} login is saved to its profile first; then ${p.displayName}'s own login starts in place.`);
  } else {
    ui.info(`Starting ${p.displayName}'s login in an isolated directory; your current login is untouched.`);
  }
  const res = await ctx.switcher.add(p, name, { discard: Boolean(ctx.flags["discard"]) });
  const state = await ctx.store.readState();
  ui.success(`Saved ${ui.s.bold(`${p.id}/${res.name}`)} ${ui.s.dim(`(${res.meta.label})`)}`);
  if (state.active[p.id] !== res.name) ui.hint(`Activate it with: acctx use ${p.id} ${res.name}`);
  else warnOverrides(ctx, p);
  return 0;
}

async function importCmd(ctx: Context, reg: Registry): Promise<number> {
  const p = reg.getProvider(need(ctx, 0, "provider"));
  const name = need(ctx, 1, "profile name");
  const meta = await ctx.switcher.importLive(p, name);
  ctx.ui.success(`Imported the current ${p.displayName} login as ${ctx.ui.s.bold(`${p.id}/${name}`)} ${ctx.ui.s.dim(`(${meta.label})`)} and made it active.`);
  warnOverrides(ctx, p);
  return 0;
}

async function use(ctx: Context, reg: Registry): Promise<number> {
  const { ui } = ctx;
  let providerId = ctx.args[0];
  let name = ctx.args[1];
  if (!providerId || !name) {
    const scope = providerId ? reg.getProvider(providerId).id : undefined;
    const profiles = await ctx.store.listProfiles(scope);
    if (profiles.length === 0) throw new UserError("No profiles to choose from.", "Add one with: acctx add <provider> <name>");
    if (!ctx.interactive) throw new UserError("Usage: acctx use <provider> <name>", "Interactive selection needs a terminal. Profiles: " + profiles.map((x) => `${x.provider}/${x.name}`).join(", "));
    const state = await ctx.store.readState();
    const w = Math.max(...profiles.map((x) => `${x.provider}/${x.name}`.length));
    const picked = await ui.select("Switch to", profiles, (x) => {
      const active = state.active[x.provider] === x.name ? ui.s.green(" " + sym.active + " active") : "";
      const label = x.meta.label !== x.name ? ui.s.dim("  " + x.meta.label) : "";
      return `${`${x.provider}/${x.name}`.padEnd(w)}${label}${active}`;
    });
    if (!picked) { ui.info("Cancelled."); return 0; }
    providerId = picked.provider;
    name = picked.name;
  }
  const p = reg.getProvider(providerId);
  const state = await ctx.store.readState();
  if (state.active[p.id] === name && ctx.switcher.liveExists(p)) {
    ui.info(`${p.id}/${name} is already active.`);
    warnOverrides(ctx, p);
    return 0;
  }
  const meta = await ctx.switcher.use(p, name, { discard: Boolean(ctx.flags["discard"]) });
  ui.success(`${p.displayName} ${sym.arrow} ${ui.s.bold(name)} ${ui.s.dim(`(${meta.label})`)}`);
  warnOverrides(ctx, p);
  return 0;
}

async function check(ctx: Context, reg: Registry): Promise<number> {
  const { ui } = ctx;
  const { s } = ui;
  const provider = ctx.args[0] ? reg.getProvider(ctx.args[0]).id : undefined;
  const only = ctx.args[1];
  let profiles = await ctx.store.listProfiles(provider);
  if (only) profiles = profiles.filter((p) => p.name === only);
  if (profiles.length === 0) throw new UserError("No matching profiles to check.");
  const state = await ctx.store.readState();
  let failures = 0;
  const w = Math.max(...profiles.map((p) => `${p.provider}/${p.name}`.length));
  for (const p of profiles) {
    const id = `${p.provider}/${p.name}`.padEnd(w);
    const active = state.active[p.provider] === p.name ? s.dim(" (active)") : "";
    const r = await ctx.switcher.verifyProfile(reg.getProvider(p.provider), p.name);
    if (r.ok) ui.out(`${s.green(sym.ok)} ${id}  ${r.label ?? ""}${active}`);
    else { failures++; ui.out(`${s.red(sym.fail)} ${id}  ${s.red(r.reason ?? "invalid")}${active}`); }
  }
  if (failures) {
    ui.warn(`${failures} of ${profiles.length} profile(s) failed.`);
    ui.hint("Re-add a failed one with: acctx remove <provider> <name> && acctx add <provider> <name>");
  }
  return failures ? 1 : 0;
}

async function rename(ctx: Context, reg: Registry): Promise<number> {
  const p = reg.getProvider(need(ctx, 0, "provider"));
  const from = need(ctx, 1, "current profile name");
  const to = need(ctx, 2, "new profile name");
  await ctx.store.renameProfile(p.id, from, to);
  ctx.ui.success(`Renamed ${p.id}/${from} ${sym.arrow} ${ctx.ui.s.bold(`${p.id}/${to}`)}`);
  return 0;
}

async function remove(ctx: Context, reg: Registry): Promise<number> {
  const { ui } = ctx;
  const p = reg.getProvider(need(ctx, 0, "provider"));
  const name = need(ctx, 1, "profile name");
  if (!(await ctx.store.hasProfile(p.id, name))) throw new UserError(`No ${p.displayName} profile named "${name}".`);
  const state = await ctx.store.readState();
  const force = Boolean(ctx.flags["force"] || ctx.flags["yes"]);
  if (state.active[p.id] === name && !force) {
    throw new UserError(`${p.id}/${name} is the active profile.`, "Switch to another profile first, or pass --force (the live login stays as it is).");
  }
  if (!force && ctx.interactive) {
    const ok = await ui.confirm(`Delete the saved login ${p.id}/${name}?`);
    if (!ok) { ui.info("Cancelled."); return 0; }
  }
  await ctx.store.removeProfile(p.id, name);
  ui.success(`Removed ${p.id}/${name}.`);
  ui.hint("The token was deleted locally, not revoked; run the provider's logout if you want revocation.");
  return 0;
}
