import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "./helpers.js";
import { findProjectFile, parseProjectFile, loadProject, resolveSelector, describeSelector } from "../src/core/project.js";

const KNOWN = ["vercel", "convex", "github"];
const meta = (label: string, tags?: string[]) => ({ label, identity: { label }, createdAt: "", updatedAt: "", ...(tags ? { tags } : {}) });

async function repo(): Promise<{ home: string; root: string }> {
  const home = await tmpDir();
  const root = path.join(home, "code", "app");
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "web"), { recursive: true });
  return { home, root };
}

test("findProjectFile: nearest wins, stops after the git root, never reads $HOME", async () => {
  const { home, root } = await repo();
  await fs.writeFile(path.join(home, ".acctx.json"), "{}");
  assert.equal(await findProjectFile(path.join(root, "packages", "web"), home), null);
  await fs.writeFile(path.join(home, "code", ".acctx.json"), "{}"); // above the git root
  assert.equal(await findProjectFile(path.join(root, "packages", "web"), home), null);
  await fs.writeFile(path.join(root, ".acctx.json"), "{}");
  assert.equal(await findProjectFile(path.join(root, "packages", "web"), home), path.join(root, ".acctx.json"));
  await fs.writeFile(path.join(root, "packages", "web", ".acctx.json"), "{}");
  assert.equal(await findProjectFile(path.join(root, "packages", "web"), home), path.join(root, "packages", "web", ".acctx.json"));
  assert.equal(await findProjectFile(home, home), null);
});

test("findProjectFile: without a git root it walks up to (not including) $HOME", async () => {
  const home = await tmpDir();
  const dir = path.join(home, "a", "b");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(home, "a", ".acctx.json"), "{}");
  assert.equal(await findProjectFile(dir, home), path.join(home, "a", ".acctx.json"));
});

test("loadProject rejects symlinks and oversized files without reading them", async () => {
  const { home, root } = await repo();
  const secret = path.join(home, "secret.json");
  await fs.writeFile(secret, '{"token":"SECRET"}');
  await fs.symlink(secret, path.join(root, ".acctx.json"));
  await assert.rejects(loadProject(root, home, KNOWN), (e: Error) => /regular file/.test(e.message) && !/SECRET/.test(e.message));
  await fs.rm(path.join(root, ".acctx.json"));
  await fs.writeFile(path.join(root, ".acctx.json"), "{" + " ".repeat(70 * 1024) + "}");
  await assert.rejects(loadProject(root, home, KNOWN), /too large/);
});

test("parseProjectFile: shorthand, objects, $schema ignored, order kept", () => {
  const entries = parseProjectFile(JSON.stringify({ $schema: "x", convex: "work", vercel: { account: "Dev@Acme.com", tag: "team" }, github: { profile: "octocat" } }), "/p/.acctx.json", KNOWN);
  assert.deepEqual(entries, [
    { provider: "convex", selector: { profile: "work" } },
    { provider: "vercel", selector: { account: "Dev@Acme.com", tag: "team" } },
    { provider: "github", selector: { profile: "octocat" } },
  ]);
});

test("parseProjectFile: errors name the path and the problem", () => {
  const bad = (obj: unknown, re: RegExp) => assert.throws(() => parseProjectFile(typeof obj === "string" ? obj : JSON.stringify(obj), "/p/.acctx.json", KNOWN), re);
  bad("not json", /\/p\/\.acctx\.json.*JSON/);
  bad([], /must be an object/);
  bad({ netlify: "x" }, /Unknown provider "netlify".*vercel, convex, github/);
  bad({ vercel: 1 }, /vercel.*string or an object/);
  bad({ vercel: {} }, /vercel.*at least one of profile, account, tag/);
  bad({ vercel: { token: "abc" } }, /Unknown field "token"/);
  bad({ vercel: { profile: "bad name" } }, /Invalid profile name/);
  bad({ vercel: { tag: "bad tag" } }, /Invalid tag/);
  bad({ vercel: { account: "a\nb" } }, /account.*printable/);
  bad({ vercel: { account: "x".repeat(257) } }, /account.*256/);
});

test("resolveSelector matches every selector; account is case-insensitive", () => {
  const profiles = [
    { name: "work", meta: meta("me@acme.com", ["work"]) },
    { name: "dev", meta: meta("dev@acme.com", ["team"]) },
    { name: "dev2", meta: meta("DEV@acme.com") },
    { name: "personal", meta: meta("me@gmail.com") },
  ];
  assert.deepEqual(resolveSelector({ profile: "WORK" }, profiles), { kind: "one", name: "work" });
  assert.deepEqual(resolveSelector({ tag: "team" }, profiles), { kind: "one", name: "dev" });
  assert.deepEqual(resolveSelector({ account: "dev@acme.com" }, profiles), { kind: "many", names: ["dev", "dev2"] });
  assert.deepEqual(resolveSelector({ account: "dev@acme.com", tag: "team" }, profiles), { kind: "one", name: "dev" });
  assert.deepEqual(resolveSelector({ profile: "work", account: "dev@acme.com" }, profiles), { kind: "none" });
  assert.deepEqual(resolveSelector({ account: "nobody@x" }, profiles), { kind: "none" });
  assert.equal(describeSelector({ account: "dev@acme.com", tag: "team" }), "account dev@acme.com, tag team");
});
