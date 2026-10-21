import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Env, RunOptions, RunResult } from "../src/core/env.js";
import type { Provider } from "../src/providers/types.js";
import { Store } from "../src/core/store.js";
import { Switcher } from "../src/core/switcher.js";
import { createUi } from "../src/core/ui.js";
import type { Context } from "../src/cli.js";

export async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "acctx-test-"));
}

export interface FakeRun { calls: Array<{ cmd: string; args: string[] }>; handler: (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult> | RunResult }

export function fakeEnv(home: string, handler?: FakeRun["handler"], fetchImpl?: typeof fetch): Env & { calls: FakeRun["calls"] } {
  const calls: FakeRun["calls"] = [];
  return {
    fetch: fetchImpl ?? (async () => { throw new Error("network disabled in tests"); }),
    home,
    xdgDataHome: path.join(home, ".local", "share"),
    xdgConfigHome: path.join(home, ".config"),
    vars: {},
    calls,
    async run(cmd, args, opts) {
      calls.push({ cmd, args });
      return handler ? handler(cmd, args, opts) : { code: 0, stdout: "", stderr: "" };
    },
  };
}

/** A provider with one required + one optional file under <home>/.fake/. */
export function fakeProvider(opts: { loginMode?: Provider["loginMode"]; onLogin?: (dir: string) => Promise<void> } = {}): Provider {
  return {
    id: "fake",
    displayName: "Fake",
    installHint: "n/a",
    cli: "fake",
    storage: { summary: "fake", location: "~/.fake", login: "fake", identity: "fake", overrideEnv: ["FAKE_TOKEN"], caveats: [], verified: "tests" },
    loginMode: opts.loginMode ?? "isolated",
    files: (env) => [
      { name: "auth.json", path: path.join(env.home, ".fake", "auth.json"), required: true, mode: 0o600 },
      { name: "config.json", path: path.join(env.home, ".fake", "config.json"), required: false, mode: 0o600 },
    ],
    async loginIsolated(dir) { await opts.onLogin?.(dir); },
    async fingerprint(paths) {
      if (!paths["auth.json"]) return null;
      try { return JSON.parse(await fs.readFile(paths["auth.json"], "utf8")).user ?? null; } catch { return null; }
    },
    async loginInPlace(env) { await opts.onLogin?.(path.join(env.home, ".fake")); },
    async identify(dir) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(dir, "auth.json"), "utf8"));
        return j.user ? { label: j.user } : null;
      } catch { return null; }
    },
  };
}

export async function writeLive(home: string, auth: object, config?: object): Promise<void> {
  const dir = path.join(home, ".fake");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify(auth));
  if (config) await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(config));
  else await fs.rm(path.join(dir, "config.json"), { force: true });
}

export async function readLive(home: string, name = "auth.json"): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(home, ".fake", name), "utf8"));
}

export async function setup() {
  const home = await tmpDir();
  const store = new Store(path.join(home, ".config", "acctx"));
  await store.init();
  return { home, store, env: fakeEnv(home) };
}

export function testContext(opts: { store: Store; env: Env; cwd?: string; args?: string[]; flags?: Record<string, string | boolean>; interactive?: boolean }): Context & { out: string[]; err: string[] } {
  const out: string[] = []; const err: string[] = [];
  const ui = createUi({ env: { NO_COLOR: "1" }, interactive: opts.interactive ?? false, writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  return { store: opts.store, switcher: new Switcher(opts.store, opts.env), args: opts.args ?? [], flags: opts.flags ?? {}, ui, interactive: opts.interactive ?? false, cwd: opts.cwd ?? opts.env.home, out, err };
}
