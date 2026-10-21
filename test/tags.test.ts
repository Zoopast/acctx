import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
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
