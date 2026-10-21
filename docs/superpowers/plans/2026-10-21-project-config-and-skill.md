# Project Config, Status, Tags, Skill Install and Guard Hook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project declare which accounts it uses in a committed `.acctx.json`, verify/apply them with `acctx status` / `acctx use`, and ship an agent skill plus a Claude Code hook so AI agents check before running provider CLIs.

**Architecture:** A new `src/core/project.ts` finds, parses and validates the untrusted project file and resolves each entry to one local profile by `profile`/`account`/`tag` selectors. `src/core/status.ts` turns a resolution plus store/switcher state into a stable status entry used by `status`, project-mode `use`, and `guard`. Commands live in `src/commands/project.ts` (init/status/use-project/tag/untag), `src/commands/skill.ts` (skill install/show + hook merge) and `src/commands/guard.ts`. The skill text ships at `skills/acctx/SKILL.md`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node ≥22 ESM, zero runtime deps, `node:test`, build with `pnpm build`, tests with `pnpm test` (`node --test "dist/test/**/*.test.js"`).

**Spec:** `docs/superpowers/specs/2026-10-21-project-config-and-skill-design.md` (read it first; it also references `docs/superpowers/specs/2026-10-21-account-switcher-design.md`).

## Global Constraints

- Zero runtime dependencies. JSON only; no TOML/YAML parser.
- Profile and tag names match `/^[a-z0-9][a-z0-9._-]{0,63}$/i` (`assertProfileName` in `src/core/store.ts`).
- `account` selector: printable, ≤ 256 chars, no control characters, compared case-insensitively to `meta.identity.label` (fallback `meta.label`).
- Project file name is exactly `.acctx.json`; max size 64 KiB; must be a regular file; `$schema` key accepted and ignored; unknown top-level or selector keys are errors.
- Discovery walks up from the start directory, examines the directory containing `.git` and then stops; never examines `$HOME` or anything above it; stops at filesystem root.
- `status` and `guard` are offline: no network, no child processes.
- Never print tokens. Errors for users are `UserError(message, hint)` (`src/core/errors.ts`), exit 1; unexpected errors exit 2.
- Status lines and data go to `ui.out` (stdout); progress/success/warn go to `ui.success/info/warn/hint` (stderr).
- Skill/hook files are not secrets: mode 0644, dirs 0755, written with `writeAtomic` from `src/core/fsx.ts`.
- Flags only from argv. Nothing in `.acctx.json` may set `--discard` or any flag.
- Commit after every task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A `.acctx.json` with a symlink pointing at a secret file (e.g. `~/.config/acctx/profiles/vercel/work/auth.json`): discovery must reject non-regular files (lstat, not stat) so the content is never parsed or echoed in an error. Test in Task 2.
2. A `.acctx.json` inside `$HOME` itself (user runs `acctx status` in `~`): must report "no project file", never treat the home dir as a project. Test in Task 2.
3. `account` selector that happens to equal two profiles' labels (same account imported twice under two names): `ambiguous`, both names listed, nothing switched. Test in Task 2 and Task 4.
4. Hook payload with `cwd` missing or a command like `echo vercel` or `git commit -m "vercel"`: only the first word of a pipeline/`&&` segment (after `npx`, `pnpm dlx`, `bunx`, `yarn dlx`) counts; `echo vercel` must exit 0. Test in Task 7.
5. Existing `.claude/settings.json` that already has other `PreToolUse` hooks or is invalid JSON: merge must preserve others and refuse (not overwrite) on invalid JSON. Test in Task 6.

---

### Task 1: Profile tags (store, list output, `tag`/`untag` commands)

**Files:**
- Modify: `src/core/store.ts` (ProfileMeta, add `addTags`/`removeTags`)
- Modify: `src/core/format.ts` (show tags in `formatList` and `formatListJson`)
- Modify: `src/commands/index.ts` (COMMANDS table, dispatch, `tag`/`untag` handlers)
- Test: `test/tags.test.ts`, `test/format.test.ts` (one added case)

**Interfaces:**
- Produces: `ProfileMeta.tags?: string[]`; `Store.addTags(provider, name, tags: string[]): Promise<string[]>` (returns resulting tag list); `Store.removeTags(provider, name, tags: string[]): Promise<string[]>`; `assertTagName(tag: string): void` exported from `src/core/store.ts`.

- [ ] **Step 1: Write failing tests**

`test/tags.test.ts`:

```ts
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
```

Add to `test/format.test.ts` (use the file's existing style; it builds `ListRow`s and calls `formatList`/`formatListJson`):

```ts
test("list shows tags dimmed and in json", () => {
  const rows = [{ provider: "vercel", name: "work", meta: { label: "me@acme.com", identity: { label: "me@acme.com" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", tags: ["team", "work"] } }];
  const text = formatList(rows, {}, { color: false, now: new Date("2026-01-01T00:00:00Z") });
  assert.match(text, /work\s+me@acme\.com\s+#team #work/);
  assert.deepEqual(JSON.parse(formatListJson(rows, {}))[0].tags, ["team", "work"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm build 2>&1 | head -20` — expected: TypeScript errors (`addTags` does not exist, `tags` not in ProfileMeta).

- [ ] **Step 3: Implement**

In `src/core/store.ts`, add to `ProfileMeta`:

```ts
  /** Local, non-secret labels used by .acctx.json `tag` selectors. Sorted, unique. */
  tags?: string[];
```

Add after `assertProfileName`:

```ts
export function assertTagName(tag: string): void {
  if (!NAME_RE.test(tag)) {
    throw new UserError(`Invalid tag "${tag}".`, "Use letters, digits, dots, dashes or underscores (max 64 chars).");
  }
}
```

Add to `Store`:

```ts
  private async requireMeta(provider: string, name: string): Promise<ProfileMeta> {
    const meta = await this.readMeta(provider, name);
    if (!meta) throw new UserError(`No ${provider} profile named "${name}".`);
    return meta;
  }

  async addTags(provider: string, name: string, tags: string[]): Promise<string[]> {
    for (const t of tags) assertTagName(t);
    const meta = await this.requireMeta(provider, name);
    const next = [...new Set([...(meta.tags ?? []), ...tags.map((t) => t.toLowerCase())])].sort();
    await this.writeMeta(provider, name, { ...meta, tags: next, updatedAt: new Date().toISOString() });
    return next;
  }

  async removeTags(provider: string, name: string, tags: string[]): Promise<string[]> {
    const meta = await this.requireMeta(provider, name);
    const drop = new Set(tags.map((t) => t.toLowerCase()));
    const next = (meta.tags ?? []).filter((t) => !drop.has(t));
    const { tags: _old, ...rest } = meta;
    await this.writeMeta(provider, name, { ...rest, ...(next.length ? { tags: next } : {}), updatedAt: new Date().toISOString() });
    return next;
  }
```

In `src/core/format.ts`: in `formatList`, where the table rows are built, add a `tags` cell: `tags: (r.meta.tags ?? []).map((t) => "#" + t).join(" ")`, give it a width in `w`, and push `c.dim(t.tags.padEnd(w.tags))` after the label cell when `w.tags > 0` (keep the existing column order: name, label, tags, details, used). In `formatListJson` add `tags: r.meta.tags ?? []` after `details`.

In `src/commands/index.ts`: add to `COMMANDS`:

```ts
  ["tag <provider> <name> <tag...>", "Attach local tags to a profile (used by .acctx.json)", ""],
  ["untag <provider> <name> <tag...>", "Remove tags from a profile", ""],
```

Dispatch: `case "tag": return tag(ctx, reg, true); case "untag": return tag(ctx, reg, false);` and:

```ts
async function tag(ctx: Context, reg: Registry, add: boolean): Promise<number> {
  const p = reg.getProvider(need(ctx, 0, "provider"));
  const name = need(ctx, 1, "profile name");
  const tags = ctx.args.slice(2);
  if (tags.length === 0) throw new UserError("Missing tag.", `Usage: acctx ${add ? "tag" : "untag"} ${p.id} ${name} <tag...>`);
  const result = add ? await ctx.store.addTags(p.id, name, tags) : await ctx.store.removeTags(p.id, name, tags);
  ctx.ui.success(`${p.id}/${name} tags: ${result.length ? result.map((t) => "#" + t).join(" ") : ctx.ui.s.dim("none")}`);
  return 0;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test 2>&1 | tail -15` — expected: all pass (previous 45 + new).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: local profile tags (tag/untag, shown in list)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Project file discovery, parsing, resolution (`src/core/project.ts`)

**Files:**
- Create: `src/core/project.ts`
- Test: `test/project.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PROJECT_FILE = ".acctx.json";
  export interface Selector { profile?: string; account?: string; tag?: string }
  export interface ProjectEntry { provider: string; selector: Selector }
  export interface ProjectConfig { file: string; entries: ProjectEntry[] }  // file order preserved
  export function findProjectFile(startDir: string, home: string): Promise<string | null>;
  export function parseProjectFile(text: string, file: string, knownProviders: readonly string[]): ProjectEntry[];
  export function loadProject(startDir: string, home: string, knownProviders: readonly string[]): Promise<ProjectConfig | null>;
  export function describeSelector(sel: Selector): string;   // e.g. `account dev@acme.com`, `tag work`, `profile work`, joined with ", "
  export type Resolution = { kind: "one"; name: string } | { kind: "none" } | { kind: "many"; names: string[] };
  export function resolveSelector(sel: Selector, profiles: Array<{ name: string; meta: ProfileMeta }>): Resolution;
  ```

- [ ] **Step 1: Write failing tests**

`test/project.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm build 2>&1 | head` — expected: cannot find module `../src/core/project.js`.

- [ ] **Step 3: Implement `src/core/project.ts`**

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import { assertProfileName, assertTagName, type ProfileMeta } from "./store.js";

export const PROJECT_FILE = ".acctx.json";
const MAX_BYTES = 64 * 1024;
const SELECTOR_KEYS = ["profile", "account", "tag"] as const;

export interface Selector { profile?: string; account?: string; tag?: string }
export interface ProjectEntry { provider: string; selector: Selector }
export interface ProjectConfig { file: string; entries: ProjectEntry[] }

function isInside(dir: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Nearest .acctx.json walking up from startDir; stops after the dir holding .git; never looks at $HOME or above. */
export async function findProjectFile(startDir: string, home: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  const homeAbs = path.resolve(home);
  while (true) {
    if (dir === homeAbs || !isInside(dir, homeAbs) && isInside(homeAbs, dir)) return null; // reached $HOME or an ancestor of it
    const candidate = path.join(dir, PROJECT_FILE);
    const st = await fs.lstat(candidate).catch(() => null);
    if (st) return candidate;
    const git = await fs.lstat(path.join(dir, ".git")).catch(() => null);
    if (git) return null; // repo root examined, stop
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadProject(startDir: string, home: string, knownProviders: readonly string[]): Promise<ProjectConfig | null> {
  const file = await findProjectFile(startDir, home);
  if (!file) return null;
  const st = await fs.lstat(file);
  if (!st.isFile()) throw new UserError(`${file} is not a regular file.`, "acctx only reads a plain .acctx.json (no symlinks).");
  if (st.size > MAX_BYTES) throw new UserError(`${file} is too large (${st.size} bytes; max ${MAX_BYTES}).`);
  const text = await fs.readFile(file, "utf8");
  return { file, entries: parseProjectFile(text, file, knownProviders) };
}

export function parseProjectFile(text: string, file: string, knownProviders: readonly string[]): ProjectEntry[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new UserError(`${file} is not valid JSON: ${(e as Error).message}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UserError(`${file} must be an object keyed by provider id.`);
  const entries: ProjectEntry[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "$schema") continue;
    if (!knownProviders.includes(key)) throw new UserError(`${file}: Unknown provider "${key}".`, `Known providers: ${knownProviders.join(", ")}`);
    entries.push({ provider: key, selector: parseSelector(value, key, file) });
  }
  return entries;
}

function parseSelector(value: unknown, provider: string, file: string): Selector {
  if (typeof value === "string") { assertProfileName(value); return { profile: value }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError(`${file}: "${provider}" must be a string or an object.`);
  const sel: Selector = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!(SELECTOR_KEYS as readonly string[]).includes(k)) throw new UserError(`${file}: "${provider}": Unknown field "${k}".`, `Allowed: ${SELECTOR_KEYS.join(", ")}`);
    if (typeof v !== "string") throw new UserError(`${file}: "${provider}.${k}" must be a string.`);
    if (k === "profile") assertProfileName(v);
    else if (k === "tag") assertTagName(v);
    else {
      if (v.length === 0 || v.length > 256) throw new UserError(`${file}: "${provider}.account" must be 1 to 256 characters.`);
      if (!/^[^\p{Cc}]+$/u.test(v) || v !== v.trim()) throw new UserError(`${file}: "${provider}.account" must be printable with no surrounding whitespace.`);
    }
    sel[k as keyof Selector] = v;
  }
  if (!sel.profile && !sel.account && !sel.tag) throw new UserError(`${file}: "${provider}" needs at least one of profile, account, tag.`);
  return sel;
}

export function describeSelector(sel: Selector): string {
  return SELECTOR_KEYS.filter((k) => sel[k]).map((k) => `${k} ${sel[k]}`).join(", ");
}

export type Resolution = { kind: "one"; name: string } | { kind: "none" } | { kind: "many"; names: string[] };

export function resolveSelector(sel: Selector, profiles: Array<{ name: string; meta: ProfileMeta }>): Resolution {
  const eq = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
  const names = profiles
    .filter((p) => (sel.profile === undefined || eq(p.name, sel.profile))
      && (sel.account === undefined || eq(p.meta.identity?.label ?? p.meta.label, sel.account))
      && (sel.tag === undefined || (p.meta.tags ?? []).some((t) => eq(t, sel.tag))))
    .map((p) => p.name);
  if (names.length === 1) return { kind: "one", name: names[0]! };
  if (names.length === 0) return { kind: "none" };
  return { kind: "many", names };
}
```

Note the `$HOME` guard: `dir === homeAbs` stops at home; the second clause stops when `dir` is an ancestor of home (so walking from `/tmp/x` with home `/home/u` works normally, and nothing above home is examined when starting under home). Keep it exactly as written and let the tests prove it.

- [ ] **Step 4: Run tests**

Run: `pnpm test 2>&1 | tail -15` — expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: .acctx.json discovery, strict parsing and selector resolution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Status computation and `acctx status`

**Files:**
- Create: `src/core/status.ts`
- Create: `src/commands/project.ts` (status only in this task; later tasks add more)
- Modify: `src/cli.ts` (add `cwd` to `Context`)
- Modify: `src/commands/index.ts` (COMMANDS row, dispatch to `statusCmd`)
- Modify: `test/helpers.ts` (add `testContext`)
- Test: `test/status.test.ts`

**Interfaces:**
- Consumes: Task 2 exports; `Switcher.liveExists/liveFingerprint/profileFingerprint/activeOverrides`; `Store.listProfiles/readState`.
- Produces:
  ```ts
  // src/core/status.ts
  export type StatusState = "ok" | "inactive" | "logged-out" | "unresolved" | "ambiguous" | "override";
  export interface StatusEntry { provider: string; selector: Selector; profile: string | null; label: string | null; state: StatusState; candidates: string[]; hint: string | null }
  export function entryStatus(store: Store, switcher: Switcher, provider: Provider, selector: Selector): Promise<StatusEntry>;
  export function projectStatus(store: Store, switcher: Switcher, reg: { getProvider(id: string): Provider }, project: ProjectConfig): Promise<StatusEntry[]>;
  export function formatStatusLine(e: StatusEntry, s: Styles, width: number): string;
  // src/cli.ts
  Context.cwd: string   // process.cwd() in main
  // test/helpers.ts
  export function testContext(opts: { store: Store; env: Env; cwd?: string; args?: string[]; flags?: Record<string, string | boolean>; interactive?: boolean }): Context & { out: string[]; err: string[] }
  ```

- [ ] **Step 1: Add `cwd` to Context and `testContext` helper**

`src/cli.ts`: add `cwd: string;` to `Context` and `cwd: process.cwd()` in the `ctx` literal in `main`.

`test/helpers.ts` append:

```ts
import { Switcher } from "../src/core/switcher.js";
import { createUi } from "../src/core/ui.js";
import type { Context } from "../src/cli.js";

export function testContext(opts: { store: Store; env: Env; cwd?: string; args?: string[]; flags?: Record<string, string | boolean>; interactive?: boolean }): Context & { out: string[]; err: string[] } {
  const out: string[] = []; const err: string[] = [];
  const ui = createUi({ env: { NO_COLOR: "1" }, interactive: opts.interactive ?? false, writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  return { store: opts.store, switcher: new Switcher(opts.store, opts.env), args: opts.args ?? [], flags: opts.flags ?? {}, ui, interactive: opts.interactive ?? false, cwd: opts.cwd ?? opts.env.home, out, err };
}
```

(Imports at top of helpers.ts; `Store` is already imported.)

- [ ] **Step 2: Write failing tests**

`test/status.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setup, fakeProvider, writeLive, testContext } from "./helpers.js";
import { entryStatus } from "../src/core/status.js";
import { runCommand } from "../src/commands/index.js";

const now = "2026-01-01T00:00:00Z";
async function saveProfile(store: any, name: string, user: string, tags?: string[]) {
  const dir = store.profileDir("fake", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ user }));
  await store.writeMeta("fake", name, { label: user, identity: { label: user }, createdAt: now, updatedAt: now, ...(tags ? { tags } : {}) });
}

test("entryStatus covers every state", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const ctx = testContext({ store, env });
  await saveProfile(store, "work", "me@acme.com", ["work"]);
  await saveProfile(store, "personal", "me@gmail.com");
  const st = (sel: any) => entryStatus(store, ctx.switcher, p, sel);

  assert.equal((await st({ profile: "nope" })).state, "unresolved");
  await saveProfile(store, "dup", "me@acme.com");
  const amb = await st({ account: "me@acme.com" });
  assert.equal(amb.state, "ambiguous"); assert.deepEqual(amb.candidates, ["dup", "work"]);

  assert.equal((await st({ tag: "work" })).state, "inactive");           // exists, not active, no live
  await store.setActive("fake", "work");
  assert.equal((await st({ tag: "work" })).state, "logged-out");         // active pointer, no live login
  await writeLive(home, { user: "me@gmail.com" });
  assert.equal((await st({ tag: "work" })).state, "inactive");           // live fingerprint differs
  await writeLive(home, { user: "me@acme.com" });
  const ok = await st({ tag: "work" });
  assert.equal(ok.state, "ok"); assert.equal(ok.profile, "work"); assert.equal(ok.label, "me@acme.com"); assert.equal(ok.hint, null);
  env.vars["FAKE_TOKEN"] = "x";
  assert.equal((await st({ tag: "work" })).state, "override");
});

test("acctx status prints lines, json, exit codes; errors without a project file", async () => {
  const { home, store, env } = await setup();
  const p = fakeProvider();
  const reg = { providers: [p], getProvider: () => p };
  const root = path.join(home, "app"); await fs.mkdir(path.join(root, ".git"), { recursive: true });
  let ctx = testContext({ store, env, cwd: root });
  await assert.rejects(runCommand("status", ctx, reg), /No \.acctx\.json/);

  await fs.writeFile(path.join(root, ".acctx.json"), JSON.stringify({ fake: { account: "me@acme.com" } }));
  await saveProfile(store, "work", "me@acme.com");
  ctx = testContext({ store, env, cwd: root });
  assert.equal(await runCommand("status", ctx, reg), 1);
  assert.match(ctx.out.join("\n"), /fake\s+✗ inactive\s+work \(me@acme\.com\).*acctx use/);

  await store.setActive("fake", "work"); await writeLive(home, { user: "me@acme.com" });
  ctx = testContext({ store, env, cwd: root, flags: { json: true } });
  assert.equal(await runCommand("status", ctx, reg), 0);
  const j = JSON.parse(ctx.out.join("\n"));
  assert.equal(j.ok, true); assert.equal(j.file, path.join(root, ".acctx.json"));
  assert.deepEqual(j.entries[0], { provider: "fake", selector: { account: "me@acme.com" }, profile: "work", label: "me@acme.com", state: "ok", candidates: [], hint: null });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm build 2>&1 | head` — expected: cannot find `../src/core/status.js`.

- [ ] **Step 4: Implement `src/core/status.ts`**

```ts
import type { Store } from "./store.js";
import type { Switcher } from "./switcher.js";
import type { Provider } from "../providers/types.js";
import { resolveSelector, describeSelector, type Selector, type ProjectConfig } from "./project.js";
import { sym, type Styles } from "./ui.js";

export type StatusState = "ok" | "inactive" | "logged-out" | "unresolved" | "ambiguous" | "override";

export interface StatusEntry {
  provider: string;
  selector: Selector;
  profile: string | null;
  label: string | null;
  state: StatusState;
  candidates: string[];
  hint: string | null;
}

export async function entryStatus(store: Store, switcher: Switcher, provider: Provider, selector: Selector): Promise<StatusEntry> {
  const base = { provider: provider.id, selector, profile: null, label: null, candidates: [] as string[] };
  const profiles = await store.listProfiles(provider.id);
  const res = resolveSelector(selector, profiles);
  if (res.kind === "none") return { ...base, state: "unresolved", hint: `No ${provider.displayName} profile matches ${describeSelector(selector)}. Add one: acctx add ${provider.id} <name>${selector.tag ? `, then: acctx tag ${provider.id} <name> ${selector.tag}` : ""}` };
  if (res.kind === "many") return { ...base, state: "ambiguous", candidates: res.names, hint: `Several ${provider.displayName} profiles match ${describeSelector(selector)}: ${res.names.join(", ")}. Add a tag or profile field to pick one.` };
  const meta = profiles.find((p) => p.name === res.name)!.meta;
  const entry = { ...base, profile: res.name, label: meta.identity?.label ?? meta.label };
  const overrides = switcher.activeOverrides(provider);
  if (overrides.length) return { ...entry, state: "override", hint: `${overrides.join(", ")} is set; the ${provider.displayName} CLI will ignore the switched login. Unset it.` };
  const state = await store.readState();
  const live = await switcher.liveExists(provider);
  if (state.active[provider.id] !== res.name) return { ...entry, state: "inactive", hint: "acctx use" };
  if (!live) return { ...entry, state: "logged-out", hint: "acctx use" };
  if (provider.fingerprint) {
    const [lf, pf] = await Promise.all([switcher.liveFingerprint(provider), switcher.profileFingerprint(provider, res.name)]);
    if (lf !== pf) return { ...entry, state: "inactive", hint: "acctx use" };
  }
  return { ...entry, state: "ok", hint: null };
}

export async function projectStatus(store: Store, switcher: Switcher, reg: { getProvider(id: string): Provider }, project: ProjectConfig): Promise<StatusEntry[]> {
  const out: StatusEntry[] = [];
  for (const e of project.entries) out.push(await entryStatus(store, switcher, reg.getProvider(e.provider), e.selector));
  return out;
}

export function formatStatusLine(e: StatusEntry, s: Styles, width: number): string {
  const id = s.cyan(e.provider.padEnd(width));
  const who = e.profile ? `${s.bold(e.profile)} ${s.dim(`(${e.label ?? ""})`)}` : s.dim(describeSelector(e.selector));
  const mark = e.state === "ok" ? s.green(sym.ok) : e.state === "override" ? s.yellow(sym.warn) : s.red(sym.fail);
  const tail = e.hint ? `  ${s.dim(sym.arrow + " " + e.hint)}` : "";
  return `${id}  ${mark} ${e.state.padEnd(10)} ${who}${tail}`;
}
```

Check `src/core/ui.ts` exports `sym.arrow` (it does; `›`) and `Styles` has `cyan`, `yellow`, `red`, `green`, `bold`, `dim`.

- [ ] **Step 5: Implement `src/commands/project.ts` (status only)**

```ts
import type { Context } from "../cli.js";
import type { Provider } from "../providers/types.js";
import { UserError } from "../core/errors.js";
import { loadProject, type ProjectConfig } from "../core/project.js";
import { projectStatus, formatStatusLine, type StatusEntry } from "../core/status.js";

export interface Registry { providers: readonly Provider[]; getProvider(id: string): Provider }

export async function requireProject(ctx: Context, reg: Registry): Promise<ProjectConfig> {
  const project = await loadProject(ctx.cwd, ctx.switcher.env.home, reg.providers.map((p) => p.id));
  if (!project) throw new UserError("No .acctx.json found in this project.", "Create one with: acctx init");
  return project;
}

export function printStatus(ctx: Context, project: ProjectConfig, entries: StatusEntry[]): void {
  const w = Math.max(...entries.map((e) => e.provider.length));
  for (const e of entries) ctx.ui.out(formatStatusLine(e, ctx.ui.s, w));
  const bad = entries.filter((e) => e.state !== "ok").length;
  if (bad) ctx.ui.warn(`${bad} of ${entries.length} account(s) not ready (${project.file}).`);
}

export async function statusCmd(ctx: Context, reg: Registry): Promise<number> {
  const project = await requireProject(ctx, reg);
  if (project.entries.length === 0) throw new UserError(`${project.file} lists no providers.`, "Run: acctx init --force");
  const entries = await projectStatus(ctx.store, ctx.switcher, reg, project);
  const ok = entries.every((e) => e.state === "ok");
  if (ctx.flags["json"]) ctx.ui.out(JSON.stringify({ file: project.file, ok, entries }, null, 2));
  else printStatus(ctx, project, entries);
  return ok ? 0 : 1;
}
```

In `src/commands/index.ts`: import `{ statusCmd }` from `./project.js`; add COMMANDS row `["status", "Check the project's .acctx.json against the active accounts", "--json"]`; dispatch `case "status": return statusCmd(ctx, reg);`. Export the `Registry` interface from `index.ts` or move it to `project.ts` and import it back (the plan puts it in `project.ts`; make `index.ts` do `import { type Registry, statusCmd } from "./project.js"` and delete its local one).

- [ ] **Step 6: Run tests**

Run: `pnpm test 2>&1 | tail -15` — expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: acctx status reports .acctx.json against active accounts (offline, --json)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Project-mode `acctx use` and `--pick`

**Files:**
- Modify: `src/commands/project.ts` (add `useProject`)
- Modify: `src/commands/index.ts` (`use` branches into project mode; COMMANDS row text)
- Test: `test/use-project.test.ts`

**Interfaces:**
- Consumes: `projectStatus`, `printStatus`, `requireProject`; `Switcher.use(provider, name, { discard })`.
- Produces: `export async function useProject(ctx: Context, reg: Registry, project: ProjectConfig): Promise<number>`.

- [ ] **Step 1: Write failing tests**

`test/use-project.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test 2>&1 | grep -E "^not ok|failing" | head` — expected: the two new tests fail (use ignores the project and throws Usage / No profiles).

- [ ] **Step 3: Implement**

Append to `src/commands/project.ts`:

```ts
import { UserError } from "../core/errors.js";  // already imported above
import { sym } from "../core/ui.js";

export async function useProject(ctx: Context, reg: Registry, project: ProjectConfig): Promise<number> {
  const { ui } = ctx;
  const entries = await projectStatus(ctx.store, ctx.switcher, reg, project);
  const state = await ctx.store.readState();
  const todo = entries.filter((e) => e.state === "inactive" || e.state === "logged-out");
  const blocked = entries.filter((e) => !["ok", "inactive", "logged-out"].includes(e.state));
  if (blocked.length) printStatus(ctx, project, blocked);
  if (todo.length === 0) {
    if (!blocked.length) ui.info(`Everything in ${project.file} is already active; nothing to do.`);
    return blocked.length ? 1 : 0;
  }
  const w = Math.max(...todo.map((e) => e.provider.length));
  for (const e of todo) ui.info(`${ui.s.cyan(e.provider.padEnd(w))}  ${state.active[e.provider] ?? ui.s.dim("none")} ${sym.arrow} ${ui.s.bold(e.profile!)} ${ui.s.dim(`(${e.label})`)}`);
  let failed = 0;
  for (const e of todo) {
    const p = reg.getProvider(e.provider);
    try {
      const meta = await ctx.switcher.use(p, e.profile!, { discard: Boolean(ctx.flags["discard"]) });
      ui.success(`${p.displayName} ${sym.arrow} ${ui.s.bold(e.profile!)} ${ui.s.dim(`(${meta.label})`)}`);
    } catch (err) {
      failed++;
      if (err instanceof UserError) ui.error(`${p.displayName}: ${err.message}`, err.hint);
      else throw err;
    }
  }
  if (failed || blocked.length) ui.warn(`${failed + blocked.length} of ${entries.length} account(s) not applied.`);
  return failed || blocked.length ? 1 : 0;
}
```

In `src/commands/index.ts` `use()`: at the top, before the picker branch:

```ts
  if (!providerId && !name && !ctx.flags["pick"]) {
    const project = await loadProject(ctx.cwd, ctx.switcher.env.home, reg.providers.map((p) => p.id));
    if (project) return useProject(ctx, reg, project);
  }
```

(import `loadProject` from `../core/project.js` and `useProject` from `./project.js`). Update the COMMANDS row: `["use [provider] [name]", "Switch to a profile; with no args applies .acctx.json (or picker with --pick)", "--discard --pick"]`.

- [ ] **Step 4: Run tests**

Run: `pnpm test 2>&1 | tail -15` — expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: acctx use with no args applies the project's .acctx.json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `acctx init`

**Files:**
- Modify: `src/commands/project.ts` (add `initCmd`, `writeProjectFile`)
- Modify: `src/commands/index.ts` (COMMANDS row, dispatch)
- Test: `test/init.test.ts`

**Interfaces:**
- Consumes: `Store.listProfiles/readState`, `ui.select/confirm`, `writeAtomic` from `src/core/fsx.ts`, `PROJECT_FILE`.
- Produces: `export async function initCmd(ctx: Context, reg: Registry, installSkill?: (scope: "project" | "global") => Promise<void>): Promise<number>` — the optional callback is wired in Task 6; this task passes nothing and skips the skill question when it is absent.

- [ ] **Step 1: Write failing tests**

`test/init.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test 2>&1 | grep -E "^not ok" | head` — expected: `Unknown command "init"`.

- [ ] **Step 3: Implement**

Append to `src/commands/project.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { exists, writeAtomic } from "../core/fsx.js";
import { PROJECT_FILE, type Selector } from "../core/project.js";
import type { ProfileMeta } from "../core/store.js";

const SKIP = Symbol("skip");

function selectorFor(name: string, meta: ProfileMeta, shared: boolean, ui: Context["ui"], providerId: string): string | Selector {
  if (!shared) return name;
  const label = meta.identity?.label;
  if (label) return { account: label };
  ui.warn(`${providerId}/${name} has no stored identity; wrote its local name instead (teammates will need to adapt it).`);
  return name;
}

export async function writeProjectFile(file: string, body: Record<string, string | Selector>): Promise<void> {
  await writeAtomic(file, JSON.stringify(body, null, 2) + "\n", 0o644);
}

export async function initCmd(ctx: Context, reg: Registry, installSkill?: (scope: "project" | "global") => Promise<void>): Promise<number> {
  const { ui } = ctx;
  const file = path.join(ctx.cwd, PROJECT_FILE);
  if (exists(file) && !ctx.flags["force"]) throw new UserError(`${file} already exists.`, "Overwrite it with: acctx init --force");
  let shared = Boolean(ctx.flags["shared"]);
  const fromActive = Boolean(ctx.flags["from-active"]);
  if (!fromActive && !ctx.interactive) throw new UserError("acctx init needs a terminal to pick profiles.", "Or write the active ones without prompts: acctx init --from-active");
  const state = await ctx.store.readState();
  const body: Record<string, string | Selector> = {};
  if (fromActive) {
    for (const p of reg.providers) {
      const name = state.active[p.id];
      if (!name) continue;
      const meta = await ctx.store.readMeta(p.id, name);
      if (meta) body[p.id] = selectorFor(name, meta, shared, ui, p.id);
    }
    if (Object.keys(body).length === 0) throw new UserError("No active profiles to write.", "Switch to the accounts this project uses first: acctx use <provider> <name>");
  } else {
    if (!ctx.flags["shared"]) {
      const who = await ui.select("Who will use this file?", ["just me (pin by profile name)", "my team (pin by account)"], (x) => x);
      if (who === null) { ui.info("Cancelled."); return 0; }
      shared = who.startsWith("my team");
    }
    for (const p of reg.providers) {
      const profiles = await ctx.store.listProfiles(p.id);
      if (profiles.length === 0) { ui.info(`${p.id}: no profiles, skipped.`); continue; }
      const items: Array<typeof profiles[number] | typeof SKIP> = [...profiles, SKIP];
      const picked = await ui.select(`${p.displayName} account for this project`, items, (x) => x === SKIP ? ui.s.dim("skip") : `${x.name}  ${ui.s.dim(x.meta.label)}${state.active[p.id] === x.name ? ui.s.green("  active") : ""}`);
      if (picked === null) { ui.info("Cancelled."); return 0; }
      if (picked === SKIP) continue;
      body[p.id] = selectorFor(picked.name, picked.meta, shared, ui, p.id);
    }
    if (Object.keys(body).length === 0) throw new UserError("Nothing selected; no file written.");
  }
  await writeProjectFile(file, body);
  ui.success(`Wrote ${ui.s.bold(file)}`);
  for (const [id, sel] of Object.entries(body)) ui.out(`  ${ui.s.cyan(id)}  ${typeof sel === "string" ? `profile ${sel}` : Object.entries(sel).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  ui.hint("Commit it (it holds no secrets). Check it any time with: acctx status");
  if (installSkill && ctx.interactive) {
    const scope = await ui.select("Install the acctx skill for AI agents?", ["project", "global", "skip"], (x) => x);
    if (scope === "project" || scope === "global") await installSkill(scope);
  } else if (installSkill && ctx.flags["yes"]) await installSkill("project");
  return 0;
}
```

(`fs` import is unused until Task 6's hook; drop it if the compiler complains about unused imports — it will not, but keep the file clean.)

In `src/commands/index.ts`: COMMANDS row `["init", "Write .acctx.json for this project (pick an account per provider)", "--from-active --shared --force"]`; dispatch `case "init": return initCmd(ctx, reg);`.

- [ ] **Step 4: Run tests**

Run: `pnpm test 2>&1 | tail -15` — expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: acctx init writes .acctx.json (interactive picker, --from-active, --shared)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Skill file, `acctx skill install|show`, hook merge

**Files:**
- Create: `skills/acctx/SKILL.md`
- Create: `src/core/skillfile.ts` (package root + target paths + hook merge, pure)
- Create: `src/commands/skill.ts`
- Modify: `src/commands/index.ts` (COMMANDS, dispatch; wire `initCmd` with the install callback)
- Modify: `package.json` (`files: ["dist", "skills"]`)
- Test: `test/skill.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/core/skillfile.ts
  export const AGENTS: Record<string, { project: string; global: string }>;  // claude-code, universal, cursor, codex → relative dirs
  export function packageRoot(): string;                                     // dir containing package.json and skills/
  export function skillSourcePath(): string;                                 // <root>/skills/acctx/SKILL.md
  export function skillTargets(agents: string[], scope: "project" | "global", cwd: string, home: string): string[];  // unique absolute SKILL.md paths
  export function mergeGuardHook(settingsText: string | null): { text: string; changed: boolean };  // throws UserError on invalid JSON
  export const GUARD_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "acctx guard" }] };
  // src/commands/skill.ts
  export async function skillCmd(ctx: Context): Promise<number>;             // subcommands install | show
  export async function installSkill(ctx: Context, scope: "project" | "global", opts: { agents?: string[]; hook?: boolean }): Promise<void>;
  ```

- [ ] **Step 1: Write the skill**

`skills/acctx/SKILL.md`:

```markdown
---
name: acctx
description: Use before running vercel, convex, gh, supabase, wrangler or clerk commands in a project that has a .acctx.json file. Verify the right accounts are active with `acctx status`; switch with `acctx use`. Also use when asked which account a project uses or to set one up.
---

# acctx: use the project's accounts

acctx switches the logins of developer CLIs (Vercel, Convex, GitHub, Supabase, Cloudflare Wrangler, Clerk). A project declares which accounts it uses in `.acctx.json` at its root. Your job is to make sure those accounts are active before you run any of those CLIs.

## Before running a provider CLI

1. If the project has `.acctx.json`, run:
   ```bash
   acctx status --json
   ```
   Do this before the first `vercel`, `convex`, `gh`, `supabase`, `wrangler` or `clerk` command of the session, and again after anything that could have changed a login.
2. If `"ok": false`, run `acctx use`, then `acctx status --json` again. Show the user both outputs.
3. If `acctx use` refuses (an unsaved login, a different account, an unresolved entry), stop and tell the user what it said. Do not work around it.

## Rules

- Never pass `--discard`, `--force` or `-y` to acctx on the user's behalf. Those destroy or overwrite logins; only the user decides.
- Never print, copy or move credential files. acctx never prints tokens; neither should you.
- acctx covers CLI logins only. MCP servers and IDE plugins for the same providers authenticate separately; `acctx status` says nothing about them.
- `acctx status` is offline and safe to run as often as needed. Exit code 0 means every entry is `ok`.

## Status states

`ok`, `inactive` (saved but not the active login), `logged-out`, `unresolved` (no local profile matches), `ambiguous` (several match), `override` (an env var like `VERCEL_TOKEN` is set and the CLI will ignore the switched login). Each JSON entry carries a `hint`.

## File format (`.acctx.json`, committed, no secrets)

```json
{
  "vercel":  { "account": "dev@acme.com" },
  "convex":  { "tag": "work" },
  "github":  "octocat"
}
```

Keys are provider ids. A value is a local profile name, or an object with any of `profile` (local name), `account` (the login's email/username), `tag` (a local tag set with `acctx tag <provider> <name> <tag>`). All given fields must match one local profile.

## Setting a project up

`acctx init` (interactive) or `acctx init --from-active`. Add `--shared` to pin by account for a team. `acctx list` shows the saved profiles; `acctx add <provider> <name>` logs into a new one.
```

- [ ] **Step 2: Write failing tests**

`test/skill.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm build 2>&1 | head` — expected: cannot find `../src/core/skillfile.js`.

- [ ] **Step 4: Implement `src/core/skillfile.ts`**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.js";

/** Install dirs per agent, relative to the project root / $HOME (vercel-labs/skills conventions). */
export const AGENTS: Record<string, { project: string; global: string }> = {
  "claude-code": { project: ".claude/skills", global: ".claude/skills" },
  universal: { project: ".agents/skills", global: ".config/agents/skills" },
  cursor: { project: ".agents/skills", global: ".cursor/skills" },
  codex: { project: ".agents/skills", global: ".agents/skills" },
};
export const DEFAULT_AGENTS = ["claude-code", "universal"];

/** dist/src/core/skillfile.js → package root (three levels up). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function skillSourcePath(): string {
  return path.join(packageRoot(), "skills", "acctx", "SKILL.md");
}

export function skillTargets(agents: string[], scope: "project" | "global", cwd: string, home: string): string[] {
  const out: string[] = [];
  for (const a of agents) {
    const dirs = AGENTS[a];
    if (!dirs) throw new UserError(`Unknown agent "${a}".`, `Known: ${Object.keys(AGENTS).join(", ")}`);
    const p = path.join(scope === "project" ? cwd : home, dirs[scope], "acctx", "SKILL.md");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export const GUARD_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "acctx guard" }] };

export function mergeGuardHook(settingsText: string | null): { text: string; changed: boolean } {
  let settings: Record<string, unknown> = {};
  if (settingsText !== null && settingsText.trim() !== "") {
    try { settings = JSON.parse(settingsText); } catch (e) { throw new UserError(`settings.json is not valid JSON: ${(e as Error).message}`, "Fix it by hand, then run the install again."); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new UserError("settings.json must be a JSON object.");
  }
  const hooks = (settings["hooks"] && typeof settings["hooks"] === "object" ? settings["hooks"] : {}) as Record<string, unknown>;
  const pre = Array.isArray(hooks["PreToolUse"]) ? (hooks["PreToolUse"] as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>) : [];
  const present = pre.some((h) => (h.hooks ?? []).some((x) => x.command === "acctx guard"));
  if (present) return { text: settingsText ?? "", changed: false };
  const next = { ...settings, hooks: { ...hooks, PreToolUse: [...pre, GUARD_HOOK] } };
  return { text: JSON.stringify(next, null, 2) + "\n", changed: true };
}
```

- [ ] **Step 5: Implement `src/commands/skill.ts`**

```ts
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "../cli.js";
import { UserError } from "../core/errors.js";
import { ensureDir, exists, writeAtomic } from "../core/fsx.js";
import { DEFAULT_AGENTS, mergeGuardHook, skillSourcePath, skillTargets } from "../core/skillfile.js";

export async function installSkill(ctx: Context, scope: "project" | "global", opts: { agents?: string[]; hook?: boolean } = {}): Promise<void> {
  const { ui } = ctx;
  const home = ctx.switcher.env.home;
  const source = await fs.readFile(skillSourcePath(), "utf8");
  const targets = skillTargets(opts.agents ?? DEFAULT_AGENTS, scope, ctx.cwd, home);
  if (scope === "global" && !ctx.flags["yes"]) {
    if (!ctx.interactive) throw new UserError("Installing globally writes under your home directory.", `Confirm with --yes. Targets:\n${targets.map((t) => "  " + t).join("\n")}`);
    ui.info(`This writes:\n${targets.map((t) => "  " + t).join("\n")}`);
    if (!(await ui.confirm("Install the acctx skill globally?", true))) { ui.info("Skipped."); return; }
  }
  for (const target of targets) {
    if (exists(target)) {
      const current = await fs.readFile(target, "utf8");
      if (current === source) { ui.info(`${target} is up to date.`); continue; }
      if (!ctx.flags["force"]) {
        if (!ctx.interactive) throw new UserError(`${target} exists and differs from the packaged skill.`, "Overwrite it with --force.");
        if (!(await ui.confirm(`${target} differs. Overwrite?`, false))) { ui.info("Kept."); continue; }
      }
    }
    await ensureDir(path.dirname(target), 0o755);
    await writeAtomic(target, source, 0o644);
    ui.success(`Installed ${target}`);
  }
  if (opts.hook) {
    const settings = path.join(scope === "project" ? ctx.cwd : home, ".claude", "settings.json");
    const text = exists(settings) ? await fs.readFile(settings, "utf8") : null;
    const merged = mergeGuardHook(text);
    if (!merged.changed) ui.info(`${settings} already runs acctx guard.`);
    else {
      await ensureDir(path.dirname(settings), 0o755);
      await writeAtomic(settings, merged.text, 0o644);
      ui.success(`Added a PreToolUse hook (Bash → acctx guard) to ${settings}`);
      ui.hint("It blocks provider CLI commands when the project's accounts are not active. Remove the entry from that file to disable it.");
    }
  }
}

export async function skillCmd(ctx: Context): Promise<number> {
  const sub = ctx.args[0];
  if (sub === "show") { ctx.ui.out((await fs.readFile(skillSourcePath(), "utf8")).replace(/\n$/, "")); return 0; }
  if (sub !== "install") throw new UserError("Usage: acctx skill install [--global] [--agent a,b] [--hook] | acctx skill show");
  const agents = typeof ctx.flags["agent"] === "string" ? ctx.flags["agent"].split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  await installSkill(ctx, ctx.flags["global"] ? "global" : "project", { ...(agents ? { agents } : {}), hook: Boolean(ctx.flags["hook"]) });
  ctx.ui.hint("Other agents: acctx skill show, or `npx skills add <this repo>` once published.");
  return 0;
}
```

Check `ensureDir(p, mode)` exists in `src/core/fsx.ts` with that signature (it does: `ensureDir(p: string, mode: number)`).

In `src/commands/index.ts`: COMMANDS rows `["skill install", "Install the acctx skill for AI agents (project; --global for all projects)", "--global --agent --hook --force"]` and `["skill show", "Print the skill text for any agent", ""]`; dispatch `case "skill": return skillCmd(ctx);` and change `case "init"` to `return initCmd(ctx, reg, (scope) => installSkill(ctx, scope));`. Add to the `main` guard in `src/cli.ts` nothing (no change).

`package.json`: `"files": ["dist", "skills"]`.

- [ ] **Step 6: Run tests**

Run: `pnpm test 2>&1 | tail -15` — expected: all pass. Then sanity check from the linked binary: `cd $(mktemp -d) && acctx skill show | head -3` prints the frontmatter (the package root resolution must work from `dist/src/core`).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: ship skills/acctx/SKILL.md; acctx skill install|show with optional Claude Code guard hook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `acctx guard` (Claude Code PreToolUse hook)

**Files:**
- Create: `src/core/guard.ts` (pure parsing)
- Create: `src/commands/guard.ts`
- Modify: `src/commands/index.ts` (dispatch only; hidden, not in COMMANDS)
- Modify: `src/providers/types.ts` + each provider (`cli: string` field, the executable name)
- Test: `test/guard.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/core/guard.ts
  export function invokedClis(command: string, clis: readonly string[]): string[];   // unique, in order
  export function parseHookPayload(text: string): { toolName: string | null; command: string | null; cwd: string | null };
  // providers/types.ts
  Provider.cli: string   // "vercel" | "convex" | "gh" | "supabase" | "wrangler" | "clerk"
  // commands/guard.ts
  export async function guardCmd(ctx: Context, reg: Registry, readStdin: () => Promise<string>): Promise<number>;  // 0 allow, 2 block
  ```

- [ ] **Step 1: Write failing tests**

`test/guard.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm build 2>&1 | head` — expected: cannot find `../src/core/guard.js`; `cli` not in Provider.

- [ ] **Step 3: Add `cli` to the provider contract**

`src/providers/types.ts`: add to `Provider` after `installHint`: `/** Executable name of the provider's CLI, used by the guard hook. */ cli: string;`. Set it in each provider: vercel `"vercel"`, convex `"convex"`, github `"gh"`, supabase `"supabase"`, cloudflare `"wrangler"`, clerk `"clerk"`. In `test/helpers.ts` `fakeProvider`, add `cli: "fake"`. In `test/providers.test.ts` the contract guard test may list required keys; add `cli` there if it does.

- [ ] **Step 4: Implement `src/core/guard.ts`**

```ts
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const DLX = new Set(["pnpm", "yarn", "bun"]);

/** Provider CLIs invoked in command position of any shell segment. Conservative: it is a tokenizer, not a shell parser. */
export function invokedClis(command: string, clis: readonly string[]): string[] {
  const out: string[] = [];
  for (const segment of command.split(/\|\||&&|[|;\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;        // env assignments
    if (i < words.length && RUNNERS.has(words[i]!)) i++;
    else if (i + 1 < words.length && DLX.has(words[i]!) && words[i + 1] === "dlx") i += 2;
    while (i < words.length && words[i]!.startsWith("-")) i++;                          // runner flags like -y
    const head = words[i];
    if (!head) continue;
    const name = head.split("/").pop()!;
    if (clis.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

export function parseHookPayload(text: string): { toolName: string | null; command: string | null; cwd: string | null } {
  try {
    const j = JSON.parse(text) as { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return { toolName: str(j.tool_name), command: str(j.tool_input?.command), cwd: str(j.cwd) };
  } catch {
    return { toolName: null, command: null, cwd: null };
  }
}
```

- [ ] **Step 5: Implement `src/commands/guard.ts`**

```ts
import type { Context } from "../cli.js";
import { UserError } from "../core/errors.js";
import { loadProject } from "../core/project.js";
import { invokedClis, parseHookPayload } from "../core/guard.js";
import { entryStatus, formatStatusLine } from "../core/status.js";
import { redact } from "../core/redact.js";
import type { Registry } from "./project.js";

/** Claude Code PreToolUse hook. Exit 0 allows the tool call; exit 2 blocks it and shows stderr to the agent. */
export async function guardCmd(ctx: Context, reg: Registry, readStdin: () => Promise<string>): Promise<number> {
  const { ui } = ctx;
  try {
    const payload = parseHookPayload(await readStdin());
    if (payload.toolName !== "Bash" || !payload.command) return 0;
    const byCli = new Map(reg.providers.map((p) => [p.cli, p] as const));
    const hit = invokedClis(payload.command, [...byCli.keys()]);
    if (hit.length === 0) return 0;
    const project = await loadProject(payload.cwd ?? ctx.cwd, ctx.switcher.env.home, reg.providers.map((p) => p.id));
    if (!project) return 0;
    const wanted = new Set(hit.map((c) => byCli.get(c)!.id));
    const entries = project.entries.filter((e) => wanted.has(e.provider));
    if (entries.length === 0) return 0;
    const statuses = [];
    for (const e of entries) statuses.push(await entryStatus(ctx.store, ctx.switcher, reg.getProvider(e.provider), e.selector));
    const bad = statuses.filter((s) => s.state !== "ok");
    if (bad.length === 0) return 0;
    const w = Math.max(...bad.map((s) => s.provider.length));
    ui.error(`acctx: this project (${project.file}) expects other accounts for: ${bad.map((s) => s.provider).join(", ")}`);
    for (const s of bad) ui.out(formatStatusLine(s, ui.s, w));
    ui.hint("Run: acctx use   (then retry). Ask the user before passing --discard.");
    return 2;
  } catch (e) {
    const msg = e instanceof UserError ? `${e.message}${e.hint ? "\n  " + e.hint : ""}` : (e as Error).message;
    ui.error(`acctx guard failed: ${redact(msg)}`, "Fix the problem, or remove the acctx guard hook from .claude/settings.json.");
    return 2;
  }
}
```

Note: `ui.out` goes to stdout in the hook; Claude Code shows stderr on exit 2, so route the status lines through stderr instead: replace `ui.out(formatStatusLine(...))` with `ui.hint(formatStatusLine(...))`. Update the test regex accordingly (it reads `ctx.err`; `hint` writes to err). Keep it that way.

In `src/commands/index.ts`: dispatch `case "guard": return guardCmd(ctx, reg, readStdinText);` with:

```ts
async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
```

Do not add `guard` to COMMANDS (hidden), but mention it in the help footer: `s.dim("acctx guard is the Claude Code hook installed by: acctx skill install --hook")`.

- [ ] **Step 6: Run tests**

Run: `pnpm test 2>&1 | tail -15` — expected: all pass. Manual: `echo '{"tool_name":"Bash","tool_input":{"command":"echo vercel"},"cwd":"/tmp"}' | acctx guard; echo $?` → 0.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: acctx guard, a Claude Code PreToolUse hook that blocks provider CLIs on account mismatch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Package metadata, README, help, spec cross-reference

**Files:**
- Modify: `package.json` (name `acctx`, remove the `dependencies` block with `"account-switcher": "link:"`, add `repository`/`keywords`, keep `files: ["dist","skills"]`)
- Modify: `README.md` (new sections: Project file, `status`/`use`/`init`, tags, AI agents: skill + hook, `npx skills add`)
- Modify: `src/cli.ts` (`--version` string stays `0.1.0`; no change unless the name is printed)
- Modify: `test/cli.test.ts` (help lists `init`, `status`, `tag`, `skill`)
- Test: existing suite

- [ ] **Step 1: Update help test**

In `test/cli.test.ts`, extend the command list in the help test with `"init", "status", "tag", "untag", "skill"`.

- [ ] **Step 2: package.json**

Set `"name": "acctx"`, delete the `dependencies` object entirely, add `"repository": { "type": "git", "url": "" }` only if the user has given a URL (otherwise omit), add `"keywords": ["vercel", "convex", "github", "supabase", "cloudflare", "clerk", "account", "switch", "cli"]`. Run `pnpm install` so the lockfile no longer references the self link, and verify `pnpm ls` shows no runtime deps. Re-link the global binary: `npm link` (the bin name is unchanged).

- [ ] **Step 3: README**

Add after the usage section:

```markdown
## Project accounts (`.acctx.json`)

Pin the accounts a project uses, commit the file (it holds no secrets), and let acctx verify and apply them:

```bash
acctx init            # pick an account per provider (add --shared for a team file)
acctx status          # offline check; exit 1 when something is off (--json for agents)
acctx use             # apply the file (with no arguments; --pick for the picker)
```

```json
{
  "vercel":  { "account": "dev@acme.com" },
  "convex":  { "tag": "work" },
  "github":  "octocat"
}
```

A value selects one local profile by `profile` (local name), `account` (the login's email/username, portable across machines), and/or `tag` (`acctx tag github octocat work`). Teams pin shared accounts by `account` and each dev's own account by `tag`.

## AI agents

`acctx skill install` copies `skills/acctx/SKILL.md` into `.claude/skills/` and `.agents/skills/` (`--global` for every project, `--agent cursor,codex` to pick). The skill tells the agent to run `acctx status --json` before provider CLIs and `acctx use` on mismatch, and never to pass `--discard`/`--force` by itself.

`acctx skill install --hook` also adds a Claude Code `PreToolUse` hook (`acctx guard`) that blocks `vercel`/`convex`/`gh`/`supabase`/`wrangler`/`clerk` commands while the project's accounts are not active. Other tools: `acctx skill show`, or `npx skills add <repo>`.
```

Also add `tag`/`untag` to the commands table and `status`/`init`/`skill` rows.

- [ ] **Step 4: Run tests and the real binary**

Run: `pnpm test 2>&1 | tail -5`; then in a temp dir with a `.git` folder: `acctx init --from-active && acctx status; echo $?` on the real machine (vercel/convex/github/supabase profiles exist) and `acctx use` (should say nothing to do or apply). Report the output verbatim.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: rename package to acctx, document project files, skill and guard hook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
