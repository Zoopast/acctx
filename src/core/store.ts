import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, readJson, writeAtomic, exists } from "./fsx.js";
import { UserError } from "./errors.js";
import type { Identity } from "../providers/types.js";

export interface ProfileMeta {
  label: string;
  /** Offline, non-secret identity fingerprint (provider-specific), if any. */
  fingerprint?: string;
  identity: Identity | null;
  createdAt: string;
  updatedAt: string;
  /** Last time this profile was switched to (or imported/added). */
  lastUsedAt?: string;
  /** Local, non-secret labels used by .acctx.json `tag` selectors. Sorted, unique. */
  tags?: string[];
}

export interface State {
  active: Record<string, string>;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function assertProfileName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new UserError(
      `Invalid profile name "${name}".`,
      "Use letters, digits, dots, dashes or underscores (max 64 chars).",
    );
  }
}

export function assertTagName(tag: string): void {
  if (!NAME_RE.test(tag)) {
    throw new UserError(`Invalid tag "${tag}".`, "Use letters, digits, dots, dashes or underscores (max 64 chars).");
  }
}

export class Store {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await ensureDir(this.root, 0o700);
    await ensureDir(path.join(this.root, "profiles"), 0o700);
  }

  profileDir(provider: string, name: string): string {
    assertProfileName(name);
    return path.join(this.root, "profiles", provider, name);
  }

  async hasProfile(provider: string, name: string): Promise<boolean> {
    return exists(path.join(this.profileDir(provider, name), "meta.json"));
  }

  async listProfiles(provider?: string): Promise<Array<{ provider: string; name: string; meta: ProfileMeta }>> {
    const base = path.join(this.root, "profiles");
    const providers = provider ? [provider] : await safeReaddir(base);
    const out: Array<{ provider: string; name: string; meta: ProfileMeta }> = [];
    for (const p of providers) {
      for (const name of await safeReaddir(path.join(base, p))) {
        const meta = await readJson<ProfileMeta>(path.join(base, p, name, "meta.json"));
        if (meta) out.push({ provider: p, name, meta });
      }
    }
    return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  }

  async readMeta(provider: string, name: string): Promise<ProfileMeta | null> {
    return readJson<ProfileMeta>(path.join(this.profileDir(provider, name), "meta.json"));
  }

  async writeMeta(provider: string, name: string, meta: ProfileMeta): Promise<void> {
    const dir = this.profileDir(provider, name);
    await ensureDir(path.dirname(dir), 0o700);
    await ensureDir(dir, 0o700);
    await writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", 0o600);
  }

  private async requireMeta(provider: string, name: string): Promise<ProfileMeta> {
    const meta = await this.readMeta(provider, name);
    if (!meta) throw new UserError(`No ${provider} profile named "${name}".`);
    return meta;
  }

  /** Adds tags (idempotent). Returns the resulting sorted tag list. */
  async addTags(provider: string, name: string, tags: string[]): Promise<string[]> {
    for (const t of tags) assertTagName(t);
    const meta = await this.requireMeta(provider, name);
    const next = [...new Set([...(meta.tags ?? []), ...tags.map((t) => t.toLowerCase())])].sort();
    await this.writeMeta(provider, name, { ...meta, tags: next });
    return next;
  }

  /** Removes tags that are present; unknown tags are ignored. Returns the resulting sorted tag list. */
  async removeTags(provider: string, name: string, tags: string[]): Promise<string[]> {
    const meta = await this.requireMeta(provider, name);
    const drop = new Set(tags.map((t) => t.toLowerCase()));
    const next = (meta.tags ?? []).filter((t) => !drop.has(t));
    const { tags: _old, ...rest } = meta;
    await this.writeMeta(provider, name, { ...rest, ...(next.length ? { tags: next } : {}) });
    return next;
  }

  async removeProfile(provider: string, name: string): Promise<void> {
    await fs.rm(this.profileDir(provider, name), { recursive: true, force: true });
    const state = await this.readState();
    if (state.active[provider] === name) {
      delete state.active[provider];
      await this.writeState(state);
    }
  }

  async renameProfile(provider: string, from: string, to: string): Promise<void> {
    const src = this.profileDir(provider, from);
    const dst = this.profileDir(provider, to);
    if (!(await this.hasProfile(provider, from))) throw new UserError(`No ${provider} profile named "${from}".`);
    if (from === to) return;
    if (await this.hasProfile(provider, to)) throw new UserError(`Profile ${provider}/${to} already exists.`, "Pick another name or remove it first.");
    await fs.rename(src, dst);
    const state = await this.readState();
    if (state.active[provider] === from) {
      state.active[provider] = to;
      await this.writeState(state);
    }
  }

  async readState(): Promise<State> {
    return (await readJson<State>(path.join(this.root, "state.json"))) ?? { active: {} };
  }

  async writeState(state: State): Promise<void> {
    await writeAtomic(path.join(this.root, "state.json"), JSON.stringify(state, null, 2) + "\n", 0o600);
  }

  async setActive(provider: string, name: string | null): Promise<void> {
    const state = await this.readState();
    if (name === null) delete state.active[provider];
    else state.active[provider] = name;
    await this.writeState(state);
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return (await fs.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
