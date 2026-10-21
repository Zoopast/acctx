import type { Env } from "../core/env.js";

export interface CredentialFile {
  /** File name inside the profile dir, e.g. "auth.json". */
  name: string;
  /** Absolute path of the live file the provider's CLI reads. */
  path: string;
  /** A profile without this file is not a valid login. */
  required: boolean;
  /** Permission bits to apply when writing (live and stored copies). */
  mode: number;
}

export interface Identity {
  /** Short human label: username, email or id. Never a secret. */
  label: string;
  /** Provider-specific extras (team, user id). Never secrets. */
  details?: Record<string, string>;
}

export interface VerifyResult { ok: boolean; label?: string; reason?: string }

/** Human explanation of how a provider keeps its login; shown by `acctx providers`. */
export interface StorageInfo {
  /** One line: what the CLI writes and where. */
  summary: string;
  /** Location pattern with env placeholders, e.g. "$XDG_DATA_HOME/com.vercel.cli/auth.json". */
  location: string;
  /** How `acctx add` obtains a new login. */
  login: string;
  /** How acctx labels and checks a profile. */
  identity: string;
  /** Env vars the CLI reads instead of the file; if set, switching has no effect. */
  overrideEnv: string[];
  caveats: string[];
  /** What was actually exercised against the real CLI, and where. */
  verified: string;
}

export interface Provider {
  id: string;
  displayName: string;
  /** One-line install hint shown when the provider CLI is missing. */
  installHint: string;
  storage: StorageInfo;
  files(env: Env): CredentialFile[];
  /**
   * Some CLIs keep files in a nested layout under a config root (wrangler:
   * .wrangler/config/default.toml). Map flat profile file names to their
   * relative path under that root so the core can stage a native layout.
   */
  layout?: Record<string, string>;
  /**
   * isolated: a new login can be made into a scratch dir without touching live files.
   * in-place: the provider's CLI only logs into the live location; acctx stashes first.
   */
  loginMode: "isolated" | "in-place";
  /** Seed files for a scratch dir so the provider CLI starts a fresh login. */
  seedScratch?(dir: string): Promise<void>;
  loginIsolated?(dir: string, env: Env): Promise<void>;
  loginInPlace?(env: Env): Promise<void>;
  /**
   * Sanity-check captured files right after a capture. Return a problem
   * description (e.g. "token is in the OS keyring, not in the file") or null.
   */
  validateFiles?(dir: string): Promise<string | null>;
  /**
   * Offline non-secret identifier from the files, for mismatch detection.
   * `paths` maps file name to absolute path. Null when none exists.
   */
  fingerprint?(paths: Record<string, string>): Promise<string | null>;
  /**
   * Label for the credentials stored in `dir` (profile dir layout). May refresh
   * the credential files in `dir` as a side effect; after this call `dir` is
   * the authoritative copy and the core re-syncs it to the live location.
   */
  identify(dir: string, env: Env): Promise<Identity | null>;
  /**
   * Check that the credentials in `dir` are still accepted by the provider.
   * Like identify(), may refresh files in `dir`. Omit when identify() already
   * fails for dead credentials (the core falls back to identify() !== null).
   */
  verify?(dir: string, env: Env): Promise<VerifyResult>;
}

/** Env overrides that remove the provider's token env vars from a child process. */
export function withoutOverrides(p: Pick<Provider, "storage">): Record<string, undefined> {
  return Object.fromEntries(p.storage.overrideEnv.map((k) => [k, undefined]));
}
