import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyAtomic, exists } from "./fsx.js";

/**
 * Materialize a provider's native directory layout in a temporary root from a
 * flat profile dir, run `fn(root)`, then copy any changed or new files back
 * under their flat names. Lets CLIs that need `$CONFIG_ROOT/nested/path` work
 * with acctx's flat per-profile storage.
 */
export async function withNativeLayout<T>(
  flatDir: string,
  layout: Record<string, string>,
  fn: (root: string) => Promise<T>,
  mode = 0o600,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acctx-native-"));
  await fs.chmod(root, 0o700);
  try {
    const before = new Map<string, Buffer>();
    for (const [name, rel] of Object.entries(layout)) {
      const src = path.join(flatDir, name);
      if (exists(src)) {
        const data = await fs.readFile(src);
        before.set(name, data);
        await copyAtomic(src, path.join(root, rel), mode);
      }
    }
    const result = await fn(root);
    for (const [name, rel] of Object.entries(layout)) {
      const p = path.join(root, rel);
      if (!exists(p)) continue;
      const data = await fs.readFile(p);
      if (!before.get(name)?.equals(data)) await copyAtomic(p, path.join(flatDir, name), mode);
    }
    return result;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
