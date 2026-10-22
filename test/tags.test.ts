import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, testContext } from "./helpers.js";
import { runCommand } from "../src/commands/index.js";
import { formatList } from "../src/core/format.js";
import { assertTagName } from "../src/core/store.js";

const meta = { label: "me", identity: { label: "me" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

test("addTags is idempotent, sorted, and removeTags drops only the given tags", async () => {
  const { store } = await setup();
  await store.writeMeta("fake", "a", meta);
  assert.deepEqual(await store.addTags("fake", "a", ["work", "team"]), ["team", "work"]);
  assert.deepEqual(await store.addTags("fake", "a", ["work"]), ["team", "work"]);
  assert.deepEqual((await store.readMeta("fake", "a"))?.tags, ["team", "work"]);
  assert.deepEqual(await store.removeTags("fake", "a", ["team", "nope"]), ["work"]);
  assert.deepEqual(await store.removeTags("fake", "a", ["work"]), []);
  assert.equal((await store.readMeta("fake", "a"))?.tags, undefined);
});

test("addTags rejects bad tag names and missing profiles", async () => {
  const { store } = await setup();
  await store.writeMeta("fake", "a", meta);
  await assert.rejects(store.addTags("fake", "a", ["bad tag"]), /Invalid tag/);
  await assert.rejects(store.addTags("fake", "missing", ["work"]), /No fake profile named "missing"/);
  assert.throws(() => assertTagName("-x"), /Invalid tag/);
  assert.doesNotThrow(() => assertTagName("work.eu-1"));
});

test("tagging does not bump updatedAt (it is not use)", async () => {
  const { store } = await setup();
  await store.writeMeta("fake", "a", meta);
  await store.addTags("fake", "a", ["work"]);
  assert.equal((await store.readMeta("fake", "a"))?.updatedAt, meta.updatedAt);
  await store.removeTags("fake", "a", ["work"]);
  assert.equal((await store.readMeta("fake", "a"))?.updatedAt, meta.updatedAt);
});

test("removeTags rejects a missing profile", async () => {
  const { store } = await setup();
  await assert.rejects(store.removeTags("fake", "missing", ["work"]), /No fake profile named/);
});

test("tag command: missing tags is an error, uppercase is stored lowercase", async () => {
  const { store, env } = await setup();
  const { fakeProvider } = await import("./helpers.js");
  const p = fakeProvider();
  const reg = { providers: [p], getProvider: () => p };
  await store.writeMeta("fake", "a", meta);
  await assert.rejects(runCommand("tag", testContext({ store, env, args: ["fake", "a"] }), reg), /Missing tag/);
  assert.equal(await runCommand("tag", testContext({ store, env, args: ["fake", "a", "WORK"] }), reg), 0);
  assert.deepEqual((await store.readMeta("fake", "a"))?.tags, ["work"]);
});

test("formatList keeps the used column aligned when only some profiles are tagged", () => {
  const row = (name: string, tags?: string[]) => ({ provider: "fake", name, meta: { ...meta, label: name, ...(tags ? { tags } : {}) } });
  const out = formatList([row("aa", ["work"]), row("bb")], {}, { color: false, now: new Date("2026-01-01T01:00:00Z") });
  const lines = out.split("\n").slice(1);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.indexOf("1h ago"), lines[1]!.indexOf("1h ago"));
  assert.ok(lines[0]!.includes("#work"));
});
