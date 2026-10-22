import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setup, fakeProvider, writeLive, readLive, testContext } from "./helpers.js";
import type { Provider } from "../src/providers/types.js";
import { runCommand } from "../src/commands/index.js";

const now = "2026-01-01T00:00:00Z";
async function saveProfile(store: any, name: string, user: string) {
  const dir = store.profileDir("fake", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ user }));
  await store.writeMeta("fake", name, { label: user, identity: { label: user }, createdAt: now, updatedAt: now });
}

test("acctx use (no args) applies the project file, skips ok entries, reports the rest, continues past failures", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const reg = { providers: [p], getProvider: () => p };
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await saveProfile(store, "work", "me@acme.com");
  await saveProfile(store, "personal", "me@gmail.com");
  await store.setActive("fake", "personal"); await writeLive(home, { user: "me@gmail.com" });

  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: "work" }));
  let ctx = testContext({ store, env, cwd: root });
  assert.equal(await runCommand("use", ctx, reg), 0);
  assert.equal((await readLive(home)).user, "me@acme.com");
  assert.equal((await store.readState()).active["fake"], "work");
  assert.match(ctx.err.join("\n"), /fake\s+personal › work \(me@acme\.com\)/);

  ctx = testContext({ store, env, cwd: root });
  assert.equal(await runCommand("use", ctx, reg), 0);
  assert.match(ctx.err.join("\n"), /already active|nothing to do/i);

  // unsaved live login blocks the switch; the command reports and exits 1 (no --discard from the file)
  await writeLive(home, { user: "stranger@x" });
  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: "personal" }));
  ctx = testContext({ store, env, cwd: root });
  assert.equal(await runCommand("use", ctx, reg), 1);
  assert.equal((await readLive(home)).user, "stranger@x");
  assert.match(ctx.err.join("\n"), /different account|not saved/);

  // unresolved entries are reported, not applied
  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: { tag: "nothing" } }));
  ctx = testContext({ store, env, cwd: root });
  assert.equal(await runCommand("use", ctx, reg), 1);
  assert.match(ctx.out.join("\n"), /unresolved/);
});

test("acctx use --pick inside a project falls back to the picker (non-interactive usage error)", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const reg = { providers: [p], getProvider: () => p };
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: "work" }));
  await saveProfile(store, "work", "me@acme.com");
  await saveProfile(store, "personal", "me@gmail.com");
  await store.setActive("fake", "personal"); await writeLive(home, { user: "me@gmail.com" });
  const ctx = testContext({ store, env, cwd: root, flags: { pick: true } });
  await assert.rejects(runCommand("use", ctx, reg), /Usage: acctx use <provider> <name>/);
  assert.equal((await readLive(home)).user, "me@gmail.com");
  assert.equal((await store.readState()).active["fake"], "personal");
  assert.doesNotMatch(ctx.err.join("\n"), /›/);
});

function fake2(): Provider {
  const base = fakeProvider();
  const f = (home: string) => path.join(home, ".fake2", "auth.json");
  return {
    ...base,
    id: "fake2",
    displayName: "Fake2",
    files: (env) => [{ name: "auth.json", path: f(env.home), required: true, mode: 0o600 }],
    async identify(dir) {
      try { const j = JSON.parse(await fs.readFile(path.join(dir, "auth.json"), "utf8")); return j.user ? { label: j.user } : null; } catch { return null; }
    },
  };
}
async function saveProfile2(store: any, name: string, user: string) {
  const dir = store.profileDir("fake2", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ user }));
  await store.writeMeta("fake2", name, { label: user, identity: { label: user }, createdAt: now, updatedAt: now });
}
async function writeLive2(home: string, user: string) {
  await fs.mkdir(path.join(home, ".fake2"), { recursive: true });
  await fs.writeFile(path.join(home, ".fake2", "auth.json"), JSON.stringify({ user }));
}
const readLive2 = async (home: string) => JSON.parse(await fs.readFile(path.join(home, ".fake2", "auth.json"), "utf8"));

test("a failing entry does not stop later entries; ok entries are not re-switched", async () => {
  const { home, store, env } = await setup();
  const p1 = fakeProvider(), p2 = fake2();
  const reg = { providers: [p1, p2], getProvider: (id: string) => (id === "fake2" ? p2 : p1) };
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await saveProfile(store, "work", "me@acme.com");
  await saveProfile(store, "personal", "me@gmail.com");
  await saveProfile2(store, "a", "a@x");
  await saveProfile2(store, "b", "b@x");
  await store.setActive("fake", "personal"); await writeLive(home, { user: "stranger@x" });
  await store.setActive("fake2", "a"); await writeLive2(home, "a@x");
  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: "work", fake2: "b" }));
  let ctx = testContext({ store, env, cwd: root });
  assert.equal(await runCommand("use", ctx, reg), 1);
  assert.equal((await readLive(home)).user, "stranger@x");
  assert.equal((await readLive2(home)).user, "b@x");
  assert.match(ctx.err.join("\n"), /Fake: .*(different account|not saved)/);

  // fake2 is now ok; only the todo entry is switched
  await writeLive(home, { user: "me@gmail.com" });
  await writeLive2(home, "b@x");
  await store.setActive("fake2", "b");
  ctx = testContext({ store, env, cwd: root });
  assert.equal(await runCommand("use", ctx, reg), 0);
  assert.equal((await readLive(home)).user, "me@acme.com");
  assert.doesNotMatch(ctx.err.join("\n"), /fake2\s/);
});

test("ok entries are left untouched on disk", async () => {
  const { home, store, env } = await setup();
  const p1 = fakeProvider(), p2 = fake2();
  const reg = { providers: [p1, p2], getProvider: (id: string) => (id === "fake2" ? p2 : p1) };
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await saveProfile(store, "work", "me@acme.com");
  await saveProfile(store, "personal", "me@gmail.com");
  await saveProfile2(store, "b", "b@x");
  await store.setActive("fake", "personal"); await writeLive(home, { user: "me@gmail.com" });
  await store.setActive("fake2", "b");
  await fs.mkdir(path.join(home, ".fake2"), { recursive: true });
  // marker field the saved profile copy lacks: a re-switch would overwrite the file and drop it
  await fs.writeFile(path.join(home, ".fake2", "auth.json"), JSON.stringify({ user: "b@x", marker: 1 }));
  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: "work", fake2: "b" }));
  assert.equal(await runCommand("use", testContext({ store, env, cwd: root }), reg), 0);
  assert.equal((await readLive(home)).user, "me@acme.com");
  assert.deepEqual(await readLive2(home), { user: "b@x", marker: 1 });
  const saved = JSON.parse(await fs.readFile(path.join(store.profileDir("fake2", "b"), "auth.json"), "utf8"));
  assert.equal(saved.marker, undefined); // a re-switch would have captured the live file into the profile
  assert.equal((await store.readMeta("fake2", "b"))?.lastUsedAt, undefined);
});

test("--discard lists the providers it will apply to before switching", async () => {
  const { home, store, env } = await setup();
  const p1 = fakeProvider(), p2 = fake2();
  const reg = { providers: [p1, p2], getProvider: (id: string) => (id === "fake2" ? p2 : p1) };
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await saveProfile(store, "work", "me@acme.com");
  await saveProfile2(store, "b", "b@x");
  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: "work", fake2: "b" }));
  const ctx = testContext({ store, env, cwd: root, flags: { discard: true } });
  assert.equal(await runCommand("use", ctx, reg), 0);
  const lines = ctx.err;
  const w = lines.findIndex((l) => l.includes("--discard will replace unsaved logins for: fake, fake2"));
  const ok = lines.findIndex((l) => l.includes("✓"));
  assert.ok(w >= 0 && ok >= 0 && w < ok, lines.join("\n"));
});

test("empty .acctx.json errors like status", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const reg = { providers: [p], getProvider: () => p };
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".acctx.json"), "{}");
  await assert.rejects(runCommand("use", testContext({ store, env, cwd: root }), reg), (e: any) => /lists no providers/.test(e.message) && /acctx init --force/.test(e.hint));
});
