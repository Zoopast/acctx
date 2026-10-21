import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyAtomic, ensureDir, exists, removeIfExists } from "./fsx.js";
import { UserError } from "./errors.js";
import type { Store, ProfileMeta } from "./store.js";
import type { Env } from "./env.js";
import type { Provider, Identity } from "../providers/types.js";

export interface SwitchOptions {
  /** Overwrite live credentials that are not saved in any profile. */
  discard?: boolean;
}

export class Switcher {
  constructor(private readonly store: Store, private readonly env: Env) {}

  /** True when at least one required live file exists. */
  liveExists(provider: Provider): boolean {
    return provider.files(this.env).some((f) => f.required && exists(f.path));
  }

  /** Copy live credential files into a profile dir. Returns false if nothing live. */
  async captureLive(provider: Provider, name: string): Promise<boolean> {
    if (!this.liveExists(provider)) return false;
    const dir = this.store.profileDir(provider.id, name);
    await ensureDir(path.dirname(dir), 0o700);
    await ensureDir(dir, 0o700);
    for (const f of provider.files(this.env)) {
      const dst = path.join(dir, f.name);
      if (exists(f.path)) await copyAtomic(f.path, dst, f.mode);
      else await removeIfExists(dst);
    }
    return true;
  }

  /** Save the live login as `name` and mark it active. */
  async importLive(provider: Provider, name: string): Promise<ProfileMeta> {
    if (!this.liveExists(provider)) {
      throw new UserError(
        `No live ${provider.displayName} login found to import.`,
        `Log in with the ${provider.displayName} CLI first, or run: acctx add ${provider.id} ${name}`,
      );
    }
    if (await this.store.hasProfile(provider.id, name)) {
      throw new UserError(`Profile ${provider.id}/${name} already exists.`, "Pick another name or remove it first.");
    }
    await this.captureLive(provider, name);
    const meta = await this.finalizeProfile(provider, name);
    // identify() may have refreshed the stored copy; the profile is now authoritative.
    await this.applyProfile(provider, name);
    await this.store.setActive(provider.id, name);
    return meta;
  }

  /**
   * Make sure whatever is live right now is saved somewhere, so switching
   * never destroys a login. Re-captures rotated tokens into the active profile.
   */
  async stashLive(provider: Provider, opts: SwitchOptions = {}): Promise<void> {
    if (!this.liveExists(provider)) return;
    const state = await this.store.readState();
    const active = state.active[provider.id];
    if (active && (await this.store.hasProfile(provider.id, active))) {
      await this.captureLive(provider, active);
      const meta = await this.store.readMeta(provider.id, active);
      if (meta) await this.store.writeMeta(provider.id, active, { ...meta, updatedAt: new Date().toISOString() });
      return;
    }
    if (!opts.discard) {
      throw new UserError(
        `Your current ${provider.displayName} login is not saved in any profile.`,
        `Save it first with: acctx import ${provider.id} <name>\n  Or overwrite it with: --discard`,
      );
    }
  }

  async use(provider: Provider, name: string, opts: SwitchOptions = {}): Promise<ProfileMeta> {
    if (!(await this.store.hasProfile(provider.id, name))) {
      const names = (await this.store.listProfiles(provider.id)).map((p) => p.name);
      throw new UserError(
        `No ${provider.displayName} profile named "${name}".`,
        names.length ? `Available: ${names.join(", ")}` : `Create one with: acctx add ${provider.id} ${name}`,
      );
    }
    await this.stashLive(provider, opts);
    await this.applyProfile(provider, name);
    await this.store.setActive(provider.id, name);
    const meta = await this.store.readMeta(provider.id, name);
    return meta ?? { label: name, identity: null, createdAt: "", updatedAt: "" };
  }

  /** Copy a profile's files over the live location (atomic per file). */
  private async applyProfile(provider: Provider, name: string): Promise<void> {
    const dir = this.store.profileDir(provider.id, name);
    for (const f of provider.files(this.env)) {
      const src = path.join(dir, f.name);
      if (exists(src)) await copyAtomic(src, f.path, f.mode);
      else if (f.required) throw new UserError(`Profile ${provider.id}/${name} is missing ${f.name}.`, "Remove and re-add it.");
      else await removeIfExists(f.path);
    }
  }

  /** Obtain a brand-new login and save it as a profile. */
  async add(provider: Provider, name: string | undefined, opts: SwitchOptions = {}): Promise<{ name: string; meta: ProfileMeta }> {
    if (name !== undefined && (await this.store.hasProfile(provider.id, name))) {
      throw new UserError(`Profile ${provider.id}/${name} already exists.`, "Pick another name or remove it first.");
    }
    if (provider.loginMode === "isolated") {
      if (!provider.loginIsolated) throw new Error(`${provider.id}: isolated login not implemented`);
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "acctx-"));
      await fs.chmod(scratch, 0o700);
      try {
        await provider.seedScratch?.(scratch);
        await provider.loginIsolated(scratch, this.env);
        const identity = await provider.identify(scratch, this.env);
        const finalName = await this.pickName(provider, name, identity);
        const dir = this.store.profileDir(provider.id, finalName);
        await ensureDir(path.dirname(dir), 0o700);
        await ensureDir(dir, 0o700);
        for (const f of provider.files(this.env)) {
          const src = path.join(scratch, f.name);
          if (exists(src)) await copyAtomic(src, path.join(dir, f.name), f.mode);
          else if (f.required) throw new UserError(`${provider.displayName} login did not produce ${f.name}.`, "The login may have been cancelled.");
        }
        const meta = await this.finalizeProfile(provider, finalName, identity);
        return { name: finalName, meta };
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    }
    // in-place: stash current login, log in fresh, capture.
    if (!provider.loginInPlace) throw new Error(`${provider.id}: in-place login not implemented`);
    await this.stashLive(provider, opts);
    for (const f of provider.files(this.env)) await removeIfExists(f.path);
    await provider.loginInPlace(this.env);
    if (!this.liveExists(provider)) {
      throw new UserError(`${provider.displayName} login did not complete; nothing saved.`,
        `Your previous login is still saved. Restore it with: acctx use ${provider.id} <name>`);
    }
    const tmpName = name ?? `_pending_${Date.now()}`;
    await this.captureLive(provider, tmpName);
    const identity = await provider.identify(this.store.profileDir(provider.id, tmpName), this.env);
    const finalName = await this.pickName(provider, name, identity, tmpName);
    if (finalName !== tmpName) {
      await fs.rename(this.store.profileDir(provider.id, tmpName), this.store.profileDir(provider.id, finalName));
    }
    const meta = await this.finalizeProfile(provider, finalName, identity);
    await this.applyProfile(provider, finalName);
    await this.store.setActive(provider.id, finalName);
    return { name: finalName, meta };
  }

  private async pickName(provider: Provider, requested: string | undefined, identity: Identity | null, ignore?: string): Promise<string> {
    if (requested) return requested;
    const base = (identity?.label ?? "account").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
    let candidate = base;
    for (let i = 2; (await this.store.hasProfile(provider.id, candidate)) && candidate !== ignore; i++) candidate = `${base}-${i}`;
    return candidate;
  }

  private async finalizeProfile(provider: Provider, name: string, identity?: Identity | null): Promise<ProfileMeta> {
    const dir = this.store.profileDir(provider.id, name);
    const id = identity === undefined ? await provider.identify(dir, this.env) : identity;
    const now = new Date().toISOString();
    const existing = await this.store.readMeta(provider.id, name);
    const meta: ProfileMeta = {
      label: id?.label ?? name,
      identity: id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.writeMeta(provider.id, name, meta);
    return meta;
  }
}
