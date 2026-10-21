import { test } from "node:test";
import assert from "node:assert/strict";
import { convex } from "../src/providers/convex.js";
import { fakeEnv } from "./helpers.js";

test("convex has one required file and logs in in place via npx", async () => {
  const env = fakeEnv("/h");
  assert.deepEqual(convex.files(env).map((f) => [f.path, f.required]), [["/h/.convex/config.json", true]]);
  assert.equal(convex.loginMode, "in-place");
  await convex.loginInPlace!(env);
  assert.deepEqual(env.calls[0], { cmd: "npx", args: ["convex", "login"] });
});
