import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setup, fakeProvider, testContext } from "./helpers.js";
import { runCommand } from "../src/commands/index.js";

const now = "2026-01-01T00:00:00Z";

test("init --from-active writes profile selectors; --shared writes account selectors; refuses overwrite without --force", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const reg = { providers: [p], getProvider: () => p };
  const root = path.join(home, "app"); await fs.mkdir(root, { recursive: true });
  await store.writeMeta("fake", "work", { label: "me@acme.com", identity: { label: "me@acme.com" }, createdAt: now, updatedAt: now });
  await store.setActive("fake", "work");

  let ctx = testContext({ store, env, cwd: root, flags: { "from-active": true } });
  assert.equal(await runCommand("init", ctx, reg), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, ".acctx.json"), "utf8")), { fake: "work" });
  assert.match(ctx.err.join("\n"), /acctx status/);

  ctx = testContext({ store, env, cwd: root, flags: { "from-active": true, shared: true } });
  await assert.rejects(runCommand("init", ctx, reg), /already exists.*--force/);

  ctx = testContext({ store, env, cwd: root, flags: { "from-active": true, shared: true, force: true } });
  assert.equal(await runCommand("init", ctx, reg), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, ".acctx.json"), "utf8")), { fake: { account: "me@acme.com" } });
});

test("init without --from-active needs a terminal; with nothing active it says so", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const reg = { providers: [p], getProvider: () => p };
  const root = path.join(home, "app"); await fs.mkdir(root, { recursive: true });
  let ctx = testContext({ store, env, cwd: root });
  await assert.rejects(runCommand("init", ctx, reg), /needs a terminal|--from-active/);
  ctx = testContext({ store, env, cwd: root, flags: { "from-active": true } });
  await assert.rejects(runCommand("init", ctx, reg), /No active profiles/);
});
