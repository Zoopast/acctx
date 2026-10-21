import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setup, fakeProvider, writeLive, readLive, testContext } from "./helpers.js";
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
  const root = path.join(home, "app"); await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: "work" }));
  await saveProfile(store, "work", "me@acme.com");
  const ctx = testContext({ store, env, cwd: root, flags: { pick: true } });
  await assert.rejects(runCommand("use", ctx, reg), /Usage: acctx use <provider> <name>/);
});
