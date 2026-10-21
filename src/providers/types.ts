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

export interface Provider {
  id: string;
  displayName: string;
  /** One-line install hint shown when the provider CLI is missing. */
  installHint: string;
  files(env: Env): CredentialFile[];
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
   * Label for the credentials stored in `dir` (profile dir layout). May refresh
   * the credential files in `dir` as a side effect; after this call `dir` is
   * the authoritative copy and the core re-syncs it to the live location.
   */
  identify(dir: string, env: Env): Promise<Identity | null>;
}
