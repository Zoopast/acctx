#!/usr/bin/env node
import path from "node:path";
import { realEnv } from "./core/env.js";
import { Store } from "./core/store.js";
import { Switcher } from "./core/switcher.js";
import { UserError } from "./core/errors.js";
import { redact } from "./core/redact.js";
import { providers, getProvider } from "./providers/index.js";
import { runCommand, HELP } from "./commands/index.js";

export interface Context {
  store: Store;
  switcher: Switcher;
  args: string[];
  flags: Record<string, string | boolean>;
  out: (s: string) => void;
  err: (s: string) => void;
  interactive: boolean;
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (k) flags[k] = v ?? true;
    } else if (a === "-h") flags["help"] = true;
    else if (a === "-f") flags["force"] = true;
    else positional.push(a);
  }
  return { positional, flags };
}

export async function main(argv: string[]): Promise<number> {
  process.umask(0o077);
  const { positional, flags } = parseArgs(argv);
  const env = realEnv();
  const root = env.vars["ACCTX_HOME"] ?? path.join(env.xdgConfigHome, "acctx");
  const store = new Store(root);
  const ctx: Context = {
    store,
    switcher: new Switcher(store, env),
    args: positional.slice(1),
    flags,
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !flags["non-interactive"],
  };
  const cmd = positional[0];
  if (!cmd || flags["help"] && !cmd) { ctx.out(HELP); return 0; }
  try {
    await store.init();
    return await runCommand(cmd, ctx, { providers, getProvider });
  } catch (e) {
    if (e instanceof UserError) {
      ctx.err(`error: ${redact(e.message)}`);
      if (e.hint) ctx.err(`  ${redact(e.hint).split("\n").join("\n  ")}`);
      return e.exitCode;
    }
    const err = e as Error;
    ctx.err(`unexpected error: ${redact(err.message ?? String(e))}`);
    if (env.vars["ACCTX_DEBUG"] && err.stack) ctx.err(redact(err.stack));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
