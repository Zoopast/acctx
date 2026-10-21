#!/usr/bin/env node
import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { realEnv } from "./core/env.js";
import { Store } from "./core/store.js";
import { Switcher } from "./core/switcher.js";
import { UserError } from "./core/errors.js";
import { redact } from "./core/redact.js";
import { createUi, type Ui } from "./core/ui.js";
import { providers, getProvider } from "./providers/index.js";
import { runCommand, helpText } from "./commands/index.js";

export interface Context {
  store: Store;
  switcher: Switcher;
  args: string[];
  flags: Record<string, string | boolean>;
  ui: Ui;
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
    else if (a === "-y") flags["yes"] = true;
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
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !flags["non-interactive"];
  const ui = createUi({ env: env.vars, interactive });
  const ctx: Context = { store, switcher: new Switcher(store, env), args: positional.slice(1), flags, ui, interactive };
  const cmd = positional[0];
  if (!cmd || (flags["help"] && !cmd) || flags["version"]) {
    if (flags["version"]) { ui.out("acctx 0.1.0"); return 0; }
    ui.out(helpText(ui));
    return 0;
  }
  try {
    await store.init();
    return await runCommand(cmd, ctx, { providers, getProvider });
  } catch (e) {
    if (e instanceof UserError) {
      ui.error(redact(e.message), e.hint ? redact(e.hint) : undefined);
      return e.exitCode;
    }
    const err = e as Error;
    ui.error(`unexpected: ${redact(err.message ?? String(e))}`, env.vars["ACCTX_DEBUG"] ? undefined : "Set ACCTX_DEBUG=1 for a stack trace (secrets are redacted).");
    if (env.vars["ACCTX_DEBUG"] && err.stack) process.stderr.write(redact(err.stack) + "\n");
    return 2;
  }
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
