import fs from "node:fs/promises";
import { copyAtomic, exists, removeIfExists, writeAtomic } from "./fsx.js";
import type { CredentialFile } from "../providers/types.js";

/**
 * Where a provider's live login lives. The default is the CLI's credential
 * files; providers whose CLI uses an OS keyring supply their own store. Names
 * are the flat file names used inside a profile dir.
 */
export interface LiveStore {
  exists(): Promise<boolean>;
  /** Present entries only. */
  read(): Promise<Record<string, Buffer>>;
  /** null removes the entry. Entries not mentioned are left alone. */
  write(entries: Record<string, Buffer | null>): Promise<void>;
}

export class FileLiveStore implements LiveStore {
  constructor(private readonly files: CredentialFile[]) {}

  async exists(): Promise<boolean> {
    return this.files.some((f) => f.required && exists(f.path));
  }

  async read(): Promise<Record<string, Buffer>> {
    const out: Record<string, Buffer> = {};
    for (const f of this.files) if (exists(f.path)) out[f.name] = await fs.readFile(f.path);
    return out;
  }

  async write(entries: Record<string, Buffer | null>): Promise<void> {
    for (const f of this.files) {
      if (!(f.name in entries)) continue;
      const data = entries[f.name];
      if (data === null || data === undefined) await removeIfExists(f.path);
      else await writeAtomic(f.path, data, f.mode);
    }
  }
}

/** Copy helper kept for callers that still think in paths. */
export { copyAtomic };
