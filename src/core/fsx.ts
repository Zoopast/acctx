import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/** Write bytes to a temp file beside the target, fsync, then rename over it. */
export async function writeAtomic(target: string, data: Uint8Array | string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const fh = await fs.open(tmp, "w", mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, target);
}

export async function copyAtomic(src: string, dst: string, mode: number): Promise<void> {
  const data = await fs.readFile(src);
  await writeAtomic(dst, data, mode);
}

export const exists = (p: string): boolean => existsSync(p);

export async function removeIfExists(p: string): Promise<void> {
  await fs.rm(p, { force: true });
}

export async function ensureDir(p: string, mode: number): Promise<void> {
  await fs.mkdir(p, { recursive: true, mode });
  await fs.chmod(p, mode);
}

export async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
