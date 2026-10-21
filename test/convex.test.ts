import { test } from "node:test";
import assert from "node:assert/strict";
import { convex } from "../src/providers/convex.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fakeEnv, tmpDir } from "./helpers.js";

test("convex has one required file and logs in in place via npx", async () => {
  const env = fakeEnv("/h");
  assert.deepEqual(convex.files(env).map((f) => [f.path, f.required]), [["/h/.convex/config.json", true]]);
  assert.equal(convex.loginMode, "in-place");
  await convex.loginInPlace!(env);
  assert.deepEqual(env.calls[0], { cmd: "npx", args: ["convex", "login"] });
});

const fakeFetch = (status: number, body: unknown): typeof fetch => (async (_url: any, init: any) => {
  assert.match(String(init?.headers?.Authorization), /^Bearer tok_/);
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

test("convex identify/verify use the teams endpoint; never leak the token", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ accessToken: "tok_SECRET" }));
  const env = fakeEnv("/h", undefined, fakeFetch(200, [{ id: 1, name: "Gabriel's team" }, { id: 2, name: "Gravita" }]));
  const id = await convex.identify(dir, env);
  assert.deepEqual(id, { label: "Gabriel's team +1", details: { teams: "Gabriel's team, Gravita" } });
  assert.doesNotMatch(JSON.stringify(id), /tok_SECRET/);
  const v = await convex.verify!(dir, env);
  assert.equal(v.ok, true);
  const dead = await convex.verify!(dir, fakeEnv("/h", undefined, fakeFetch(401, {})));
  assert.equal(dead.ok, false);
  assert.match(dead.reason!, /rejected/);
  const offline = await convex.verify!(dir, fakeEnv("/h"));
  assert.equal(offline.ok, false);
  assert.match(offline.reason!, /could not reach/);
  assert.equal(await convex.identify(dir, fakeEnv("/h")), null, "offline identify degrades to unlabeled");
});
