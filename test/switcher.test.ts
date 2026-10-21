import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Switcher } from "../src/core/switcher.js";
import { UserError } from "../src/core/errors.js";
import { setup, fakeProvider, writeLive, readLive } from "./helpers.js";

test("import saves live files, marks active, applies 0600/0700", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  await writeLive(home, { token: "t1", user: "alice" }, { team: "a" });
  const meta = await new Switcher(store, env).importLive(p, "alice");
  assert.equal(meta.label, "alice");
  assert.deepEqual((await store.readState()).active, { fake: "alice" });
  const dir = store.profileDir("fake", "alice");
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, "auth.json"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(store.root)).mode & 0o777, 0o700);
});

test("use re-captures rotated tokens into the active profile before switching", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const sw = new Switcher(store, env);
  await writeLive(home, { token: "a-v1", user: "alice" }, { team: "a" });
  await sw.importLive(p, "alice");
  await writeLive(home, { token: "b-v1", user: "bob" });
  await sw.importLive(p, "bob");
  // bob's token rotates while active
  await writeLive(home, { token: "b-v2", user: "bob" });
  await sw.use(p, "alice");
  assert.equal((await readLive(home)).token, "a-v1");
  assert.equal((await readLive(home, "config.json")).team, "a");
  const saved = JSON.parse(await fs.readFile(path.join(store.profileDir("fake", "bob"), "auth.json"), "utf8"));
  assert.equal(saved.token, "b-v2", "rotated token must be captured");
  await sw.use(p, "bob");
  assert.equal((await readLive(home)).token, "b-v2");
  // optional config.json from alice must not leak into bob
  await assert.rejects(fs.access(path.join(home, ".fake", "config.json")));
});

test("use refuses to overwrite unsaved live credentials unless --discard", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const sw = new Switcher(store, env);
  await writeLive(home, { token: "a", user: "alice" });
  await sw.importLive(p, "alice");
  await store.setActive("fake", null); // simulate a login made outside acctx
  await writeLive(home, { token: "mystery", user: "who" });
  await assert.rejects(sw.use(p, "alice"), (e: unknown) => e instanceof UserError && /not saved/.test(e.message));
  assert.equal((await readLive(home)).token, "mystery");
  await sw.use(p, "alice", { discard: true });
  assert.equal((await readLive(home)).token, "a");
});

test("use with unknown profile lists available names", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const sw = new Switcher(store, env);
  await writeLive(home, { token: "a", user: "alice" });
  await sw.importLive(p, "alice");
  await assert.rejects(sw.use(p, "nope"), (e: unknown) => e instanceof UserError && /alice/.test(e.hint ?? ""));
});

test("add (isolated) logs into scratch, saves profile, leaves live untouched", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider({ onLogin: async (dir) => fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ token: "new", user: "Carol X" })) });
  const sw = new Switcher(store, env);
  await writeLive(home, { token: "a", user: "alice" });
  await sw.importLive(p, "alice");
  const { name, meta } = await sw.add(p, undefined);
  assert.equal(name, "carol-x");
  assert.equal(meta.label, "Carol X");
  assert.equal((await readLive(home)).token, "a", "live login untouched");
  assert.equal((await store.readState()).active["fake"], "alice");
  await sw.use(p, "carol-x");
  assert.equal((await readLive(home)).token, "new");
});

test("add (isolated) with cancelled login saves nothing", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const sw = new Switcher(store, env);
  await assert.rejects(sw.add(p, "x"), UserError);
  assert.equal((await store.listProfiles()).length, 0);
});

test("add (in-place) stashes the current login, logs in fresh, activates new", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider({ loginMode: "in-place", onLogin: async (dir) => fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ token: "d", user: "dan" })) });
  const sw = new Switcher(store, env);
  await writeLive(home, { token: "a", user: "alice" });
  await sw.importLive(p, "alice");
  const { name } = await sw.add(p, "dan");
  assert.equal(name, "dan");
  assert.equal((await readLive(home)).token, "d");
  assert.equal((await store.readState()).active["fake"], "dan");
  await sw.use(p, "alice");
  assert.equal((await readLive(home)).token, "a");
});

test("add (in-place) refuses when live login is unsaved", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider({ loginMode: "in-place" });
  await writeLive(home, { token: "mystery" });
  await assert.rejects(new Switcher(store, env).add(p, "x"), /not saved/);
  assert.equal((await readLive(home)).token, "mystery");
});

test("remove clears active pointer", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  await writeLive(home, { token: "a", user: "alice" });
  await new Switcher(store, env).importLive(p, "alice");
  await store.removeProfile("fake", "alice");
  assert.deepEqual((await store.readState()).active, {});
  assert.equal(await store.hasProfile("fake", "alice"), false);
});

test("profile names are validated (no path traversal)", async () => {
  const { store } = await setup();
  assert.throws(() => store.profileDir("fake", "../x"), UserError);
  assert.throws(() => store.profileDir("fake", "a/b"), UserError);
});

test("import re-syncs the profile to live after identify rotates the stored copy", async () => {
  const { home, store, env } = await setup();
  const base = fakeProvider();
  const p = {
    ...base,
    async identify(dir: string) {
      // simulate a provider CLI refreshing the token while reading the profile dir
      await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ token: "rotated", user: "alice" }));
      return { label: "alice" };
    },
  };
  await writeLive(home, { token: "old", user: "alice" });
  await new Switcher(store, env).importLive(p, "alice");
  assert.equal((await readLive(home)).token, "rotated");
});
