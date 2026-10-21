import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { providers } from "../src/providers/index.js";
import { github } from "../src/providers/github.js";
import { supabase } from "../src/providers/supabase.js";
import { cloudflare, _parseWhoami } from "../src/providers/cloudflare.js";
import { withNativeLayout } from "../src/core/stage.js";
import { fakeEnv, tmpDir } from "./helpers.js";

test("every provider satisfies the contract (scalability guard)", () => {
  const ids = new Set<string>();
  for (const p of providers) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`); ids.add(p.id);
    assert.match(p.id, /^[a-z][a-z0-9-]*$/);
    for (const k of ["summary", "location", "login", "identity", "verified"] as const) assert.ok(p.storage[k].trim(), `${p.id}: storage.${k} empty`);
    assert.ok(Array.isArray(p.storage.overrideEnv) && Array.isArray(p.storage.caveats));
    if (p.loginMode === "isolated") assert.ok(p.loginIsolated, `${p.id}: isolated but no loginIsolated`);
    else assert.ok(p.loginInPlace, `${p.id}: in-place but no loginInPlace`);
    const files = p.files(fakeEnv("/h"));
    assert.ok(files.some((f) => f.required), `${p.id}: no required file`);
    for (const f of files) { assert.ok(path.isAbsolute(f.path)); assert.equal(f.mode, 0o600); }
    if (p.layout) for (const name of Object.keys(p.layout)) assert.ok(files.some((f) => f.name === name), `${p.id}: layout names unknown file ${name}`);
    for (const f of files) assert.doesNotMatch(f.name, /\//, "flat names only");
  }
});

test("undefined env values really remove variables from the child process", async () => {
  const out = await new Promise<string>((resolve) => {
    const c = spawn(process.execPath, ["-e", "process.stdout.write(String(process.env.FAKE_TOKEN))"], { env: { ...process.env, FAKE_TOKEN: "leak", ...Object.fromEntries([["FAKE_TOKEN", undefined]]) } });
    let s = ""; c.stdout.on("data", (d) => (s += d)); c.on("close", () => resolve(s));
  });
  assert.equal(out, "undefined");
});

test("withNativeLayout stages nested paths and copies changes back flat", async () => {
  const flat = await tmpDir();
  await fs.writeFile(path.join(flat, "default.toml"), "a=1\n");
  const seen = await withNativeLayout(flat, { "default.toml": ".wrangler/config/default.toml", "extra": "x/extra" }, async (root) => {
    const p = path.join(root, ".wrangler", "config", "default.toml");
    const before = await fs.readFile(p, "utf8");
    await fs.writeFile(p, "a=2\n");
    await fs.mkdir(path.join(root, "x")); await fs.writeFile(path.join(root, "x", "extra"), "new");
    return { before, root };
  });
  assert.equal(seen.before, "a=1\n");
  assert.equal(await fs.readFile(path.join(flat, "default.toml"), "utf8"), "a=2\n");
  assert.equal(await fs.readFile(path.join(flat, "extra"), "utf8"), "new");
  await assert.rejects(fs.access(seen.root), "temp root removed");
  assert.equal((await fs.stat(path.join(flat, "default.toml"))).mode & 0o777, 0o600);
});

const HOSTS = `github.com:\n    users:\n        Zoopast:\n            oauth_token: gho_SECRETSECRETSECRETSECRETSECRET\n    git_protocol: ssh\n    oauth_token: gho_SECRETSECRETSECRETSECRETSECRET\n    user: Zoopast\n`;

test("github: config dir, fingerprint from hosts.yml, keyring detection, identify via gh api", async () => {
  const env = fakeEnv("/h");
  assert.equal(github.files(env)[0]!.path, "/h/.config/gh/hosts.yml");
  assert.equal(github.files({ ...env, vars: { GH_CONFIG_DIR: "/custom" } })[0]!.path, "/custom/hosts.yml");
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "hosts.yml"), HOSTS);
  assert.equal(await github.fingerprint!({ "hosts.yml": path.join(dir, "hosts.yml") }), "Zoopast");
  assert.equal(await github.validateFiles!(dir), null);
  await fs.writeFile(path.join(dir, "hosts.yml"), HOSTS.replace(/^\s+oauth_token:.*\n/gm, ""));
  assert.match((await github.validateFiles!(dir))!, /keyring/);
  const env2 = fakeEnv("/h", (cmd, args) => { assert.equal(cmd, "gh"); return { code: 0, stdout: args[0] === "api" ? "Zoopast\n" : "✓ Logged in to github.com account Zoopast\n", stderr: "" }; });
  await fs.writeFile(path.join(dir, "hosts.yml"), HOSTS);
  const id = await github.identify(dir, env2);
  assert.deepEqual(id, { label: "Zoopast", details: { host: "github.com" } });
  await github.loginIsolated!(dir, env2);
  assert.deepEqual(env2.calls.at(-1)?.args, ["auth", "login"]);
  assert.equal((await github.verify!(dir, env2)).ok, true);
  assert.doesNotMatch(JSON.stringify(id), /SECRET/);
});

test("supabase: raw token file, whoami via env var not argv", async () => {
  const env0 = fakeEnv("/h");
  assert.deepEqual(supabase.files(env0).map((f) => [f.path, f.required]), [["/h/.supabase/access-token", true]]);
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "access-token"), "sbp_SECRETSECRETSECRET\n");
  let seenEnv: Record<string, string | undefined> | undefined;
  const env = fakeEnv("/h", (cmd, args, opts) => {
    seenEnv = opts.env;
    assert.equal(cmd, "supabase");
    assert.ok(!args.join(" ").includes("sbp_"), "token must never be an argument");
    return { code: 0, stdout: '{"id":"u1","email":"g@x.dev","username":"gs"}\nA new version of Supabase CLI is available\n', stderr: "" };
  });
  const id = await supabase.identify(dir, env);
  assert.deepEqual(id, { label: "g@x.dev", details: { username: "gs" } });
  assert.equal(seenEnv?.["SUPABASE_ACCESS_TOKEN"], "sbp_SECRETSECRETSECRET");
  assert.equal((await supabase.verify!(dir, env)).ok, true);
  const bad = fakeEnv("/h", () => ({ code: 1, stdout: "", stderr: "Unauthorized: invalid access token\nA new version of Supabase CLI is available" }));
  const v = await supabase.verify!(dir, bad);
  assert.equal(v.ok, false); assert.match(v.reason!, /invalid access token/);
});

test("cloudflare: nested layout, XDG isolation, whoami parsing, npx fallback", async () => {
  const env0 = fakeEnv("/h");
  assert.equal(cloudflare.files(env0)[0]!.path, "/h/.config/.wrangler/config/default.toml");
  assert.deepEqual(cloudflare.layout, { "default.toml": ".wrangler/config/default.toml" });
  const out = [
    "You are logged in with an OAuth Token, associated with the email dev@example.com.",
    "┌──────────────┬──────────────────────────────────┐",
    "│ Account Name │ Account ID                       │",
    "├──────────────┼──────────────────────────────────┤",
    "│ Dev Account  │ 0123456789abcdef0123456789abcdef │",
    "└──────────────┴──────────────────────────────────┘",
  ].join("\n");
  assert.deepEqual(_parseWhoami(out), { label: "dev@example.com", details: { accounts: "Dev Account" } });
  assert.equal(_parseWhoami("You are not authenticated. Please run `wrangler login`."), null);
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "default.toml"), 'oauth_token = "SECRET"\n');
  let xdg: string | undefined;
  const env = fakeEnv("/h", (cmd, args, opts) => {
    if (cmd === "wrangler") throw Object.assign(new Error("nope"), { code: "ENOENT" });
    assert.equal(cmd, "npx"); assert.deepEqual(args.slice(0, 3), ["-y", "wrangler", "whoami"]);
    xdg = opts.env?.["XDG_CONFIG_HOME"];
    return { code: 0, stdout: out, stderr: "" };
  });
  const id = await cloudflare.identify(dir, env);
  assert.equal(id?.label, "dev@example.com");
  assert.ok(xdg && xdg !== "/h/.config", "whoami must run against a staged root, not the live config");
});
