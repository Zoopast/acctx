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
    if (!knownProviders.includes(key)) throw new UserError(`${file}: Unknown provider "${key}". Known providers: ${knownProviders.join(", ")}`);
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
