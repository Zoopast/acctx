# acctx — multi-account switcher for developer CLIs

Date: 2026-10-21 · Status: approved-by-assumption (see "Assumptions")

## Intent

Switch the locally logged-in account of developer CLIs (Vercel first, Convex
second) with one command, without pasting tokens, without losing the previous
login, and without leaving a half-written credential file behind.

Who it is for: a developer with several Vercel accounts (personal, client,
team) who today logs out and in again by hand.

Success looks like:

```
acctx add vercel work        # logs in via Vercel's own device flow, saves as "work"
acctx use vercel personal    # vercel whoami now reports the personal account
acctx use                    # interactive picker across providers
acctx list                   # shows every saved profile and which is active
```

## Assumptions (the user did not say these; correct me)

1. Node.js 24 + TypeScript, ESM, zero runtime dependencies. Tests with `node:test`.
2. The binary is named `acctx` (like `kubectx`). Package is `account-switcher`.
3. Credentials live in plain files with strict permissions, not the OS keyring.
   WSL2 here has `secret-tool` but no running keyring daemon, so a keyring
   dependency would fail on exactly this machine. The store is designed so a
   keyring backend can be added later behind the same interface.
4. Switching rewrites the provider's real credential location (for Vercel:
   `~/.local/share/com.vercel.cli/`). The alternative, keeping one directory per
   profile and pointing at it with an env var, was rejected: anything that
   shells out to `vercel` without that env var (IDE plugins, the Vercel MCP
   server, CI scripts) would silently use the wrong account.

## Facts that shape the design (verified on this machine)

- Vercel CLI 58.9 stores `auth.json` = `{token, userId, refreshToken, expiresAt}`
  (file mode 0600) and `config.json` = `{currentTeam, telemetry}` in
  `$XDG_DATA_HOME/com.vercel.cli` (default `~/.local/share/com.vercel.cli`).
- **Tokens rotate.** `refreshToken`/`expiresAt` change while a profile is in
  use. A switcher that only snapshots once will restore stale tokens. Therefore
  `use` must first re-capture the live files into the currently active profile.
- `config.json`'s `currentTeam` belongs to the account. Switching the token but
  not the team leaves the CLI pointing at a team the new token cannot access.
  So `config.json` is part of a Vercel profile. `telemetry-*.json` and
  `agent-preferences.json` are not.
- `vercel <cmd> --global-config <dir>` (`-Q`) isolates completely. With an
  `auth.json` containing `{}` the CLI starts a fresh device-code login and
  saves into that dir. This gives `add` a way to log into a *new* account
  without touching the active one.
- Convex CLI stores `~/.convex/config.json` = `{accessToken}` (confirmed on
  this machine). There is no config-dir flag. Deleting the file logs out and
  `npx convex login` logs in, per community reports:
  https://discord-questions.convex.dev/m/1345420072050626702 and
  https://discord-questions.convex.dev/m/1131204679498477578. In-place
  `add convex` requires an explicit profile name because the file holds no
  non-secret identifier to label it from.
- Credential file formats may change between CLI versions, so adapters copy
  files as opaque bytes and parse only optional label fields (`userId`).

## Architecture

```
src/
  cli.ts              arg parsing + command dispatch (no framework)
  commands/*.ts       one file per command: add, use, list, current, remove, import
  core/store.ts       profile store on disk (atomic writes, permissions)
  core/switcher.ts    the sync-then-swap algorithm
  core/redact.ts      strips anything token-like from error output
  providers/types.ts  Provider contract
  providers/vercel.ts
  providers/convex.ts
  providers/index.ts  registry: adding a provider = one file + one line here
```

### Provider contract

```ts
interface CredentialFile { name: string; path: string; required: boolean; mode: number }

interface Provider {
  id: string;                      // "vercel"
  displayName: string;             // "Vercel"
  files(env: Env): CredentialFile[];
  /** How a NEW login is obtained without destroying the live one. */
  loginMode: "isolated" | "in-place";
  /** isolated: log into `dir` (a scratch dir) using the provider's own CLI. */
  loginIsolated?(dir: string, env: Env): Promise<void>;
  /** in-place: live files were already stashed; run the provider's login. */
  loginInPlace?(env: Env): Promise<void>;
  /** Human label for a profile dir: email / username / userId. Never a token. */
  /** Offline non-secret identifier from the files, for mismatch detection. */
  fingerprint?(paths: Record<string, string>): Promise<string | null>;
  identify(dir: string, env: Env): Promise<Identity | null>;
}
```

`identify` may refresh credentials inside `dir` (Vercel's `whoami` can rotate
the token), so after calling it the core treats `dir` as authoritative and
re-syncs it to the live location when that profile is the active one.

`Env` carries `HOME`, `XDG_DATA_HOME`, `PATH` and a `run()` for subprocesses so
tests can inject fakes. Vercel is `isolated` (uses `-Q`). Convex is `in-place`.

### Store layout

```
$XDG_CONFIG_HOME/acctx/          (0700; override with ACCTX_HOME)
  state.json                     { "active": { "vercel": "work" } }
  profiles/vercel/work/
    meta.json                    { label, identity, createdAt, updatedAt }
    auth.json                    (0600, opaque copy)
    config.json
  profiles/convex/personal/
    meta.json
    config.json
```

All writes go through `writeAtomic(path, bytes, mode)`: write to
`path.tmp-<pid>`, fsync, rename. A crash never leaves a truncated credential.

### The `use` algorithm (core/switcher.ts)

1. Resolve target profile; fail if missing.
2. If `state.active[provider]` names profile A and A still exists: compare the
   live offline fingerprint (Vercel: `userId` from `auth.json`, no network)
   with A's. If they differ, someone logged in outside acctx; refuse (or skip
   the capture with `--discard`) so A is never overwritten by a foreign login.
   Otherwise copy live files → A (captures rotated tokens).
3. Else if live files exist and no active pointer: refuse with
   "live credentials are not saved; run `acctx import <provider> <name>` or pass
   `--discard`". Never silently destroy an unknown login.
4. Copy target files → live location, each atomically, with the provider's
   declared mode. Missing optional files are deleted from the live location so
   nothing from the previous account leaks (e.g. `currentTeam`).
5. Update `state.active[provider]`, then print the identity label.

### The `add` algorithm

- isolated: create scratch dir (0700) seeded per provider (Vercel: `auth.json`
  = `{}`), call `loginIsolated`, `identify`, copy into the new profile, delete
  scratch. The live login is untouched; `use` activates it later.
- in-place: run step 2/3 of `use` (stash live), delete live files, call
  `loginInPlace`, copy live → new profile, set it active. The previous account
  is safe in its profile.

`import <provider> <name>` saves whatever is live right now and marks it active.
This is also the onboarding step for an existing login.

### Commands

| command | behavior |
|---|---|
| `acctx add <provider> [name]` | new login, saved as profile; name defaults to identity |
| `acctx import <provider> <name>` | save current live login |
| `acctx use [provider] [name]` | switch; interactive picker when args missing |
| `acctx list [provider]` | table: provider, name, label, active marker |
| `acctx current [provider]` | active profile(s) |
| `acctx remove <provider> <name>` | delete profile (refuses if active unless `--force`) |
| `acctx check [provider] [name]` | validate saved logins on a scratch copy, without switching; refreshed files are written back |
| `acctx providers` | list supported providers |

Exit codes: 0 ok, 1 user error (message, no stack), 2 unexpected (stack only
with `ACCTX_DEBUG=1`, after redaction).

## Security rules

- Store dir 0700, credential copies 0600, umask set to 077 at startup.
- Tokens are never accepted as arguments and never printed, including in
  `--debug`; `redact()` masks any value of a key matching
  `/token|secret|key|password/i` and any string ≥ 32 chars of `[A-Za-z0-9_-]`
  before it reaches stderr.
- acctx makes no network calls itself, except a provider's optional
  `verify()`/`identify()` hitting that provider's own API read-only when its
  CLI offers no whoami (Convex: list teams). Login flows always go through the
  provider's own CLI as a child process with inherited stdio.
- No dependencies, so no supply-chain surface beyond Node and the provider CLI.
- `remove` deletes files; it does not revoke tokens server-side (the user can
  run `vercel logout` after `use` if they want revocation). Documented.

## Error handling

- Provider CLI not on PATH → clear message naming the install command.
- Login cancelled / timed out → scratch dir removed, nothing saved.
- Switch interrupted between files → the previous step's atomic rename means
  each file is either old or new; `acctx use` again repairs it (idempotent).
- Unknown provider / profile → list the valid names.

## Testing

- `core/store` and `core/switcher`: unit tests with a fake provider writing to
  a temp `ACCTX_HOME` and temp "live" paths. Covers rotation re-capture, the
  unsaved-live refusal, atomic write, permissions, idempotent re-run.
- `providers/vercel`: tests with a fake `vercel` script on PATH that writes a
  dummy `auth.json` when invoked with `login -Q <dir>`, and prints a name for
  `whoami`.
- `providers/convex`: same pattern with a fake `npx`.
- CLI: argument parsing and exit codes.

## Additions after v1 (2026-10-21, same day)

- **Storage description.** Every provider carries a `storage` block (summary,
  location pattern, login, identity, overrideEnv, caveats, verified) that
  `acctx providers [id]` renders. A contract test iterates the registry and
  fails on any empty field or a `loginMode` without its method, so a new
  provider cannot be registered half-described.
- **Native layouts.** Providers whose CLI needs nested paths under a config
  root (wrangler) declare `layout`; `withNativeLayout()` stages the flat
  profile in a temp root, runs the CLI, and copies changed files back.
- **Env overrides.** `storage.overrideEnv` lists variables such as `GH_TOKEN`
  that make the CLI ignore its file. `use`, `current`, `add` and `import`
  warn when one is set, and every child process acctx runs for identify /
  verify / login has them removed so a stale export cannot fake a result.
- **validateFiles.** Providers can reject a capture (gh: token in the OS
  keyring, so `hosts.yml` has no `oauth_token`). The profile is removed and
  the user told how to re-login.
- **Providers:** GitHub (isolated via `GH_CONFIG_DIR`), Supabase (in place,
  token passed to `whoami` through the environment, never argv), Cloudflare
  wrangler (isolated via `XDG_CONFIG_HOME` + layout staging; login flow not
  verified). Clerk was evaluated and skipped: its config file holds only a user
  id, no token was found in any file, and the CLI reports "not logged in"
  on this machine, so there was nothing to capture or verify.
- **UI.** One `ui.ts`: data on stdout, status on stderr (so `--json` and
  pipes stay clean), ✓/✗/● symbols, color only on a TTY honoring `NO_COLOR`,
  styled help, arrow-key picker for `use` (numbered fallback, Esc cancels,
  Ctrl-C exits 130), and a confirmation on interactive `remove`.

## Out of scope (v1)

OS keyring backend, team switching inside one account (`vercel switch` already
does this), shell completions, auto-detecting the right profile per project
directory. Each is a natural follow-up and none changes the contracts above.
