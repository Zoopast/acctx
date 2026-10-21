import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setup, fakeProvider, writeLive, testContext } from "./helpers.js";
import { entryStatus } from "../src/core/status.js";
import { runCommand } from "../src/commands/index.js";

const now = "2026-01-01T00:00:00Z";
async function saveProfile(store: any, name: string, user: string, tags?: string[]) {
  const dir = store.profileDir("fake", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ user }));
  await store.writeMeta("fake", name, { label: user, identity: { label: user }, createdAt: now, updatedAt: now, ...(tags ? { tags } : {}) });
}

test("entryStatus covers every state", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const ctx = testContext({ store, env });
  await saveProfile(store, "work", "me@acme.com", ["work"]);
  await saveProfile(store, "personal", "me@gmail.com");
  const st = (sel: any) => entryStatus(store, ctx.switcher, p, sel);

  assert.equal((await st({ profile: "nope" })).state, "unresolved");
  await saveProfile(store, "dup", "me@acme.com");
  const amb = await st({ account: "me@acme.com" });
  assert.equal(amb.state, "ambiguous"); assert.deepEqual(amb.candidates, ["dup", "work"]);

  assert.equal((await st({ tag: "work" })).state, "inactive");           // exists, not active, no live
  await store.setActive("fake", "work");
  assert.equal((await st({ tag: "work" })).state, "logged-out");         // active pointer, no live login
  await writeLive(home, { user: "me@gmail.com" });
  assert.equal((await st({ tag: "work" })).state, "inactive");           // live fingerprint differs
  await writeLive(home, { user: "me@acme.com" });
  const ok = await st({ tag: "work" });
  assert.equal(ok.state, "ok"); assert.equal(ok.profile, "work"); assert.equal(ok.label, "me@acme.com"); assert.equal(ok.hint, null);
  env.vars["FAKE_TOKEN"] = "x";
  assert.equal((await st({ tag: "work" })).state, "override");
});

test("acctx status prints lines, json, exit codes; errors without a project file", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const reg = { providers: [p], getProvider: () => p };
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".git"), { recursive: true });
  let ctx = testContext({ store, env, cwd: root });
  await assert.rejects(runCommand("status", ctx, reg), /No \.acctx\.json/);

  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: { account: "me@acme.com" } }));
  await saveProfile(store, "work", "me@acme.com");
  ctx = testContext({ store, env, cwd: root });
  assert.equal(await runCommand("status", ctx, reg), 1);
  assert.match(ctx.out.join("\n"), /fake\s+✗ inactive\s+work \(me@acme\.com\).*acctx use/);

  await store.setActive("fake", "work"); await writeLive(home, { user: "me@acme.com" });
  ctx = testContext({ store, env, cwd: root, flags: { json: true } });
  assert.equal(await runCommand("status", ctx, reg), 0);
  const j = JSON.parse(ctx.out.join("\n"));
  assert.equal(j.ok, true); assert.equal(j.file, path.join(root, ".acctx.json"));
  assert.deepEqual(j.entries[0], { provider: "fake", selector: { account: "me@acme.com" }, profile: "work", label: "me@acme.com", state: "ok", candidates: [], hint: null });
});
