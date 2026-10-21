import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { clerk, _internal } from "../src/providers/clerk.js";
import { Switcher } from "../src/core/switcher.js";
import { fakeEnv, setup, tmpDir } from "./helpers.js";

const SESSION = { accessToken: "at_SECRET", refreshToken: "rt_SECRET", expiresAt: Date.now() + 3_600_000, tokenType: "Bearer" };

/** Simulates keyctl (keyutils) and an absent secret-tool. */
function keyringSim(initial: string | null) {
  let stored = initial;
  let nextId = 100;
  const handler = (cmd: string, args: string[], opts: { input?: string }) => {
    if (cmd === "secret-tool") throw Object.assign(new Error("nope"), { code: "ENOENT" });
    assert.equal(cmd, "keyctl");
    assert.ok(!args.some((a) => a.includes("SECRET")), "session must never be an argument");
    switch (args[0]) {
      case "search": return stored ? { code: 0, stdout: `${nextId}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "keyctl_search: Required key not available" };
      case "print": return { code: 0, stdout: stored ?? "", stderr: "" };
      case "padd": stored = opts.input ?? null; nextId++; return { code: 0, stdout: `${nextId}\n`, stderr: "" };
      case "link": case "unlink": return { code: 0, stdout: "", stderr: "" };
      case "revoke": stored = null; return { code: 0, stdout: "", stderr: "" };
      default: return { code: 1, stdout: "", stderr: "unknown" };
    }
  };
  return { handler, get: () => stored };
}

test("clerk store reads/writes the keyring via keyctl and config.json via file", async () => {
  if (process.platform !== "linux") return;
  const home = await tmpDir();
  const sim = keyringSim(JSON.stringify(SESSION));
  const env = fakeEnv(home, sim.handler as any);
  await fs.mkdir(path.join(home, ".config", "clerk-cli"), { recursive: true });
  await fs.writeFile(path.join(home, ".config", "clerk-cli", "config.json"), JSON.stringify({ auth: { production: { userId: "user_1" } } }));
  const store = clerk.liveStore!(env);
  assert.equal(await store.exists(), true);
  const read = await store.read();
  assert.deepEqual(JSON.parse(read["session.json"]!.toString()), SESSION);
  assert.ok(read["config.json"]);
  await store.write({ "session.json": Buffer.from(JSON.stringify({ ...SESSION, accessToken: "at_NEW" })) });
  assert.match(sim.get()!, /at_NEW/);
  await store.write({ "session.json": null });
  assert.equal(sim.get(), null);
  assert.equal(await store.exists(), false);
});

test("clerk falls back to the credentials file when no keyring tool exists", async () => {
  const home = await tmpDir();
  const env = fakeEnv(home, () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); });
  const store = clerk.liveStore!(env);
  assert.equal(await store.exists(), false);
  await store.write({ "session.json": Buffer.from(JSON.stringify(SESSION)) });
  const f = path.join(home, ".local", "share", "clerk-cli", "credentials");
  assert.equal((await fs.stat(f)).mode & 0o777, 0o600);
  assert.equal(await store.exists(), true);
  assert.equal(await clerk.fingerprint!({}), null);
});

test("clerk identify/verify call userinfo, refresh expired sessions and write them back", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "session.json"), JSON.stringify({ ...SESSION, expiresAt: Date.now() - 1000 }));
  const calls: string[] = [];
  const env = fakeEnv("/h", undefined, (async (url: any, init: any) => {
    const u = String(url); calls.push(u);
    if (u.endsWith("/oauth/token")) {
      assert.match(String(init.body), /grant_type=refresh_token/); assert.match(String(init.body), /rt_SECRET/);
      return new Response(JSON.stringify({ access_token: "at_FRESH", refresh_token: "rt_FRESH", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
    }
    assert.equal(init.headers.Authorization, "Bearer at_FRESH");
    return new Response(JSON.stringify({ sub: "user_1", email: "me@example.com" }), { status: 200 });
  }) as typeof fetch);
  const id = await clerk.identify(dir, env);
  assert.deepEqual(id, { label: "me@example.com", details: { userId: "user_1" } });
  assert.deepEqual(calls.map((c) => new URL(c).pathname), ["/oauth/token", "/oauth/userinfo"]);
  const saved = JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf8"));
  assert.equal(saved.refreshToken, "rt_FRESH");
  const v = await clerk.verify!(dir, env);
  assert.equal(v.ok, true); assert.equal(v.label, "me@example.com");
  const dead = fakeEnv("/h", undefined, (async () => new Response("{}", { status: 401 })) as typeof fetch);
  const r = await clerk.verify!(dir, dead);
  assert.equal(r.ok, false); assert.match(r.reason!, /rejected|refused/);
});

test("core switches a keyring-backed provider end to end (import, use, stash)", async () => {
  if (process.platform !== "linux") return;
  const { store } = await setup();
  const home = await tmpDir();
  const sim = keyringSim(JSON.stringify(SESSION));
  const env = fakeEnv(home, sim.handler as any, (async () => new Response(JSON.stringify({ sub: "user_a", email: "a@x.dev" }), { status: 200 })) as typeof fetch);
  const sw = new Switcher(store, env);
  await sw.importLive(clerk, "a");
  const bSession = { ...SESSION, accessToken: "at_B", refreshToken: "rt_B" };
  // another login made via acctx add would go through the store; emulate by writing directly
  await clerk.liveStore!(env).write({ "session.json": Buffer.from(JSON.stringify(bSession)) });
  await store.setActive("clerk", null);
  await sw.importLive(clerk, "b");
  await sw.use(clerk, "a");
  assert.match(sim.get()!, /at_SECRET/);
  await sw.use(clerk, "b");
  assert.match(sim.get()!, /at_B/);
  const savedA = JSON.parse(await fs.readFile(path.join(store.profileDir("clerk", "a"), "session.json"), "utf8"));
  assert.equal(savedA.accessToken, "at_SECRET");
});
