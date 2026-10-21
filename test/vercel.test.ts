import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { vercel } from "../src/providers/vercel.js";
import { fakeEnv, tmpDir } from "./helpers.js";

test("vercel files live under XDG data dir; auth required, config optional", async () => {
  const env = fakeEnv("/h");
  const f = vercel.files(env);
  assert.equal(f[0]!.path, "/h/.local/share/com.vercel.cli/auth.json");
  assert.equal(f[0]!.required, true);
  assert.equal(f[1]!.name, "config.json");
  assert.equal(f[1]!.required, false);
});

test("vercel seeds scratch with empty auth and logs in with --global-config", async () => {
  const dir = await tmpDir();
  const env = fakeEnv("/h");
  await vercel.seedScratch!(dir);
  assert.equal(await fs.readFile(path.join(dir, "auth.json"), "utf8"), "{}\n");
  await vercel.loginIsolated!(dir, env);
  assert.deepEqual(env.calls[0], { cmd: "vercel", args: ["login", "--global-config", dir] });
});

test("vercel identify uses whoami output and non-secret fields only", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ token: "SECRET", userId: "u_1", refreshToken: "R" }));
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ currentTeam: "team_x" }));
  const env = fakeEnv("/h", () => ({ code: 0, stdout: "Vercel CLI 58.9.2\noctocat\n", stderr: "" }));
  const id = await vercel.identify(dir, env);
  assert.deepEqual(id, { label: "octocat", details: { userId: "u_1", team: "team_x" } });
  assert.doesNotMatch(JSON.stringify(id), /SECRET|"R"/);
  // falls back to userId when CLI is unavailable
  const env2 = fakeEnv("/h", () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); });
  assert.equal((await vercel.identify(dir, env2))?.label, "u_1");
});
