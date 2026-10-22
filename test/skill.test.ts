import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setup, testContext } from "./helpers.js";
import { runCommand } from "../src/commands/index.js";
import { skillTargets, mergeGuardHook, skillSourcePath } from "../src/core/skillfile.js";

const reg = { providers: [], getProvider: (id: string) => { throw new Error(id); } };

test("skillTargets maps agents and scopes to the vercel-labs/skills layout", () => {
  assert.deepEqual(skillTargets(["claude-code", "universal"], "project", "/p", "/h"), ["/p/.claude/skills/acctx/SKILL.md", "/p/.agents/skills/acctx/SKILL.md"]);
  assert.deepEqual(skillTargets(["claude-code", "universal", "cursor"], "global", "/p", "/h"), ["/h/.claude/skills/acctx/SKILL.md", "/h/.config/agents/skills/acctx/SKILL.md", "/h/.cursor/skills/acctx/SKILL.md"]);
  assert.deepEqual(skillTargets(["cursor", "codex"], "project", "/p", "/h"), ["/p/.agents/skills/acctx/SKILL.md"]);
  assert.throws(() => skillTargets(["vim"], "project", "/p", "/h"), /Unknown agent "vim"/);
});

test("mergeGuardHook adds the hook once and preserves other settings; refuses invalid JSON", () => {
  const first = mergeGuardHook(null);
  assert.equal(first.changed, true);
  const j = JSON.parse(first.text);
  assert.deepEqual(j.hooks.PreToolUse[0].hooks[0], { type: "command", command: "acctx guard" });
  const again = mergeGuardHook(first.text);
  assert.equal(again.changed, false);
  const existing = JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] }] } });
  const merged = JSON.parse(mergeGuardHook(existing).text);
  assert.deepEqual(merged.permissions, { allow: ["Bash(ls)"] });
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, "echo hi");
  assert.throws(() => mergeGuardHook("{nope"), /not valid JSON/);
});

test("skill install writes project files, skips identical, refuses changed without --force, --hook merges settings", async () => {
  const { home, store, env } = await setup();
  const root = path.join(home, "app"); await fs.mkdir(root, { recursive: true });
  let ctx = testContext({ store, env, cwd: root, args: ["install"] });
  assert.equal(await runCommand("skill", ctx, reg), 0);
  const target = path.join(root, ".claude", "skills", "acctx", "SKILL.md");
  assert.equal(await fs.readFile(target, "utf8"), await fs.readFile(skillSourcePath(), "utf8"));
  assert.ok((await fs.stat(path.join(root, ".agents", "skills", "acctx", "SKILL.md"))).isFile());

  ctx = testContext({ store, env, cwd: root, args: ["install"] });
  assert.equal(await runCommand("skill", ctx, reg), 0);
  assert.match(ctx.err.join("\n"), /up to date/);

  await fs.writeFile(target, "edited");
  ctx = testContext({ store, env, cwd: root, args: ["install"] });
  await assert.rejects(runCommand("skill", ctx, reg), /differs.*--force/);
  ctx = testContext({ store, env, cwd: root, args: ["install"], flags: { force: true } });
  assert.equal(await runCommand("skill", ctx, reg), 0);
  assert.notEqual(await fs.readFile(target, "utf8"), "edited");

  await fs.mkdir(path.join(root, ".claude"), { recursive: true });
  await fs.writeFile(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: [] } }));
  ctx = testContext({ store, env, cwd: root, args: ["install"], flags: { hook: true } });
  assert.equal(await runCommand("skill", ctx, reg), 0);
  const settings = JSON.parse(await fs.readFile(path.join(root, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "acctx guard");
  assert.deepEqual(settings.permissions, { allow: [] });
});

test("skill install --global needs --yes when not interactive; skill show prints the file", async () => {
  const { home, store, env } = await setup();
  let ctx = testContext({ store, env, args: ["install"], flags: { global: true } });
  await assert.rejects(runCommand("skill", ctx, reg), /--yes/);
  ctx = testContext({ store, env, args: ["install"], flags: { global: true, yes: true, agent: "claude-code" } });
  assert.equal(await runCommand("skill", ctx, reg), 0);
  assert.ok((await fs.stat(path.join(home, ".claude", "skills", "acctx", "SKILL.md"))).isFile());
  ctx = testContext({ store, env, args: ["show"] });
  assert.equal(await runCommand("skill", ctx, reg), 0);
  assert.match(ctx.out.join("\n"), /^---\nname: acctx/);
});

test("skill install --hook keeps existing dir/file modes and follows a settings.json symlink", async () => {
  const { home, store, env } = await setup();
  const root = path.join(home, "app");
  await fs.mkdir(path.join(root, ".claude"), { recursive: true });
  await fs.chmod(path.join(root, ".claude"), 0o700);
  const settings = path.join(root, ".claude", "settings.json");
  await fs.writeFile(settings, "{}"); await fs.chmod(settings, 0o600);
  let ctx = testContext({ store, env, cwd: root, args: ["install"], flags: { hook: true, agent: "universal" } });
  assert.equal(await runCommand("skill", ctx, reg), 0);
  assert.equal((await fs.stat(path.join(root, ".claude"))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(settings)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(settings, "utf8"), /acctx guard/);

  const root2 = path.join(home, "app2");
  await fs.mkdir(path.join(root2, ".claude"), { recursive: true });
  const target = path.join(home, "dotfiles-settings.json");
  await fs.writeFile(target, "{}");
  await fs.symlink(target, path.join(root2, ".claude", "settings.json"));
  ctx = testContext({ store, env, cwd: root2, args: ["install"], flags: { hook: true, agent: "universal" } });
  assert.equal(await runCommand("skill", ctx, reg), 0);
  assert.ok((await fs.lstat(path.join(root2, ".claude", "settings.json"))).isSymbolicLink());
  assert.match(await fs.readFile(target, "utf8"), /acctx guard/);
});

test("mergeGuardHook refuses unexpected hooks shapes instead of reshaping them", () => {
  assert.throws(() => mergeGuardHook('{"hooks": []}'), /unexpected shape/);
  assert.throws(() => mergeGuardHook('{"hooks": {"PreToolUse": {}}}'), /unexpected shape/);
  assert.throws(() => mergeGuardHook('{"hooks": {"PreToolUse": [{"matcher":"Bash","hooks":{}}]}}'), /unexpected shape/);
});

test("skill install --hook reports a dangling settings.json symlink as a user error", async () => {
  const { home, store, env } = await setup();
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".claude"), { recursive: true });
  await fs.symlink(path.join(root, "missing.json"), path.join(root, ".claude", "settings.json"));
  const ctx = testContext({ store, env, cwd: root, args: ["install"], flags: { hook: true } });
  await assert.rejects(runCommand("skill", ctx, reg), /symlink to a missing file/);
});

test("skill install --agent without a value is an error, not a silent default", async () => {
  const { store, env } = await setup();
  for (const agent of [true, ",", " , "]) {
    const ctx = testContext({ store, env, args: ["install"], flags: { agent } });
    await assert.rejects(runCommand("skill", ctx, reg), /--agent needs a value/);
  }
});

test("init --force --yes keeps a locally edited SKILL.md (force applies to .acctx.json only)", async () => {
  const { home, store, env } = await setup();
  const { fakeProvider } = await import("./helpers.js");
  const p = fakeProvider();
  const preg = { providers: [p], getProvider: () => p };
  const root = path.join(home, "app"); await fs.mkdir(root, { recursive: true });
  await store.writeMeta("fake", "work", { label: "me@acme.com", identity: { label: "me@acme.com" }, createdAt: "", updatedAt: "" });
  await store.setActive("fake", "work");
  const target = path.join(root, ".claude", "skills", "acctx", "SKILL.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "my edited skill\n");
  await fs.writeFile(path.join(root, ".acctx.json"), "{}");
  const ctx = testContext({ store, env, cwd: root, flags: { "from-active": true, force: true, yes: true } });
  assert.equal(await runCommand("init", ctx, preg), 0);
  assert.equal(await fs.readFile(target, "utf8"), "my edited skill\n");
  assert.match(ctx.err.join("\n"), /differs from the packaged skill; kept/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, ".acctx.json"), "utf8")), { fake: "work" });
});
