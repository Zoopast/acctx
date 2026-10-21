import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setup, fakeProvider, writeLive, testContext } from "./helpers.js";
import { invokedClis, parseHookPayload } from "../src/core/guard.js";
import { guardCmd } from "../src/commands/guard.js";

const CLIS = ["vercel", "convex", "gh", "supabase", "wrangler", "clerk"];

test("invokedClis finds provider CLIs only in command position", () => {
  assert.deepEqual(invokedClis("vercel deploy --prod", CLIS), ["vercel"]);
  assert.deepEqual(invokedClis("npx vercel deploy && pnpm dlx convex dev | tee log", CLIS), ["vercel", "convex"]);
  assert.deepEqual(invokedClis("bunx gh pr list; yarn dlx wrangler whoami", CLIS), ["gh", "wrangler"]);
  assert.deepEqual(invokedClis("echo vercel", CLIS), []);
  assert.deepEqual(invokedClis('git commit -m "vercel fix"', CLIS), []);
  assert.deepEqual(invokedClis("cd app && VERCEL_ORG_ID=x vercel pull", CLIS), ["vercel"]);
  assert.deepEqual(invokedClis("/usr/local/bin/vercel ls", CLIS), ["vercel"]);
  assert.deepEqual(invokedClis("", CLIS), []);
  for (const [cmd, want] of [
    ["sudo vercel deploy", ["vercel"]], ["time vercel ls", ["vercel"]], ["env FOO=1 vercel ls", ["vercel"]], ["nohup vercel dev &", ["vercel"]],
    ["pnpm exec vercel ls", ["vercel"]], ["npm exec -- convex dev", ["convex"]], ["yarn wrangler whoami", ["wrangler"]], ["pnpm vercel ls", ["vercel"]],
    ["npx -y vercel ls", ["vercel"]], ["npx -p vercel vercel ls", ["vercel"]],
    ["if true; then vercel ls; fi", ["vercel"]], ["echo $(gh api user)", ["gh"]], ["(vercel ls)", ["vercel"]], ["sleep 1 & vercel ls", ["vercel"]],
    ['bash -c "vercel ls"', ["vercel"]],
    ["echo vercel", []], ['git commit -m "vercel fix"', []], ["pnpm install vercel", []], ["ls | grep vercel", []],
  ] as const) assert.deepEqual(invokedClis(cmd, CLIS), want, cmd);
});

test("parseHookPayload tolerates garbage", () => {
  assert.deepEqual(parseHookPayload('{"tool_name":"Bash","tool_input":{"command":"vercel ls"},"cwd":"/p"}'), { toolName: "Bash", command: "vercel ls", cwd: "/p" });
  assert.deepEqual(parseHookPayload("nope"), { toolName: null, command: null, cwd: null });
  assert.deepEqual(parseHookPayload('{"tool_name":"Write"}'), { toolName: "Write", command: null, cwd: null });
});

test("guard allows non-Bash, unrelated commands, and projects without a file; blocks mismatches with exit 2", async () => {
  const { home, store, env } = await setup();
  const p = { ...fakeProvider(), cli: "fake" };
  const reg = { providers: [p], getProvider: () => p };
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".git"), { recursive: true });
  const run = async (payload: object) => { const ctx = testContext({ store, env, cwd: root }); const code = await guardCmd(ctx, reg, async () => JSON.stringify(payload)); return { code, err: ctx.err.join("\n") }; };

  assert.equal((await run({ tool_name: "Write", tool_input: {}, cwd: root })).code, 0);
  assert.equal((await run({ tool_name: "Bash", tool_input: { command: "fake deploy" }, cwd: root })).code, 0); // no project file
  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: "work" }));
  assert.equal((await run({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: root })).code, 0);
  const blocked = await run({ tool_name: "Bash", tool_input: { command: "npx fake deploy" }, cwd: root });
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /unresolved[\s\S]*acctx use/);

  const dir = store.profileDir("fake", "work"); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ user: "me" }));
  await store.writeMeta("fake", "work", { label: "me", identity: { label: "me" }, createdAt: "", updatedAt: "" });
  await store.setActive("fake", "work"); await writeLive(home, { user: "me" });
  assert.equal((await run({ tool_name: "Bash", tool_input: { command: "fake deploy" }, cwd: root })).code, 0);

  // broken project file: fail closed
  await fs.writeFile(path.join(root, ".acctx.json"), "{bad");
  const broken = await run({ tool_name: "Bash", tool_input: { command: "fake deploy" }, cwd: root });
  assert.equal(broken.code, 2); assert.match(broken.err, /not valid JSON/);
});
