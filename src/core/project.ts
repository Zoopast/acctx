import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";
import { assertProfileName, assertTagName, type ProfileMeta } from "./store.js";

export const PROJECT_FILE = ".acctx.json";
const MAX_BYTES = 64 * 1024;
const SELECTOR_KEYS = ["profile", "account", "tag"] as const;

export interface Selector { profile?: string; account?: string; tag?: string }
export interface ProjectEntry { provider: string; selector: Selector }
export interface ProjectConfig { file: string; entries: ProjectEntry[] }

/** Render a file-sourced value for an error message: JSON-quoted, control/format chars stripped, max 64 chars. */
export function safe(value: unknown): string {
  const q = (JSON.stringify(value) ?? String(value)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  return q.length > 64 ? q.slice(0, 64) + "…" : q;
}

function checkName(kind: "profile" | "tag", value: string, where: string, file: string): void {
  try { (kind === "profile" ? assertProfileName : assertTagName)(value); }
  catch (e) {
    if (e instanceof UserError) throw new UserError(`${file}: ${where}: Invalid ${kind === "profile" ? "profile name" : "tag"} ${safe(value)}.`, e.hint);
    throw e;
  }
}

async function realOr(p: string): Promise<string> {
  return fs.realpath(p).catch(() => path.resolve(p));
}

function isInside(dir: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, dir);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** Nearest .acctx.json walking up from startDir; stops after the dir holding .git; never looks at $HOME or above. */
export async function findProjectFile(startDir: string, home: string): Promise<string | null> {
  let dir = await realOr(path.resolve(startDir));
  const homeAbs = await realOr(path.resolve(home));
  while (true) {
    if (dir === homeAbs || !isInside(dir, homeAbs) && isInside(homeAbs, dir)) return null; // reached $HOME or an ancestor of it
    const candidate = path.join(dir, PROJECT_FILE);
    const st = await fs.lstat(candidate).catch(() => null);
    // POSIX: a file owned by another user is not ours to trust; walk on as if absent
    if (st && (process.getuid === undefined || st.uid === process.getuid())) return candidate;
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
  const notRegular = () => new UserError(`${file} is not a regular file.`, "acctx only reads a plain .acctx.json (no symlinks).");
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw notRegular();
    throw e;
  }
  let text: string;
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw notRegular();
    if (st.size > MAX_BYTES) throw new UserError(`${file} is too large (${st.size} bytes; max ${MAX_BYTES}).`);
    text = await handle.readFile("utf8");
  } finally { await handle.close(); }
  return { file, entries: parseProjectFile(text, file, knownProviders) };
}

export function parseProjectFile(text: string, file: string, knownProviders: readonly string[]): ProjectEntry[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new UserError(`${file} is not valid JSON: ${safe((e as Error).message)}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UserError(`${file} must be an object keyed by provider id.`);
  const entries: ProjectEntry[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "$schema") continue;
    if (!knownProviders.includes(key)) throw new UserError(`${file}: Unknown provider ${safe(key)}. Known providers: ${knownProviders.join(", ")}`);
    entries.push({ provider: key, selector: parseSelector(value, key, file) });
  }
  return entries;
}

function parseSelector(value: unknown, provider: string, file: string): Selector {
  if (typeof value === "string") { checkName("profile", value, `"${provider}"`, file); return { profile: value }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError(`${file}: ${safe(provider)} must be a string or an object.`);
  const sel: Selector = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!(SELECTOR_KEYS as readonly string[]).includes(k)) throw new UserError(`${file}: ${safe(provider)}: Unknown field ${safe(k)}.`, `Allowed: ${SELECTOR_KEYS.join(", ")}`);
    if (typeof v !== "string") throw new UserError(`${file}: "${provider}.${k}" must be a string.`);
    if (k === "profile") checkName("profile", v, `"${provider}.profile"`, file);
    else if (k === "tag") checkName("tag", v, `"${provider}.tag"`, file);
    else {
      if (v.length === 0 || v.length > 256) throw new UserError(`${file}: "${provider}.account" must be 1 to 256 characters.`);
      if (!/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u.test(v) || v !== v.trim()) throw new UserError(`${file}: "${provider}.account" must be printable (no control or invisible format characters) with no surrounding whitespace.`);
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
