# acctx

Switch between accounts for developer CLIs. Supported: Vercel, Convex, GitHub
(`gh`), Supabase, Cloudflare (`wrangler`), Clerk. Adding a provider is one
small file.

```
acctx import vercel personal     # save the account you are logged into right now
acctx add vercel work            # log into another account (Vercel's own device flow)
acctx use vercel work            # switch — `vercel whoami` now reports "work"
acctx use                        # interactive picker
acctx list                       # grouped by provider; --json for scripts
acctx check                      # verify every saved login is still accepted, without switching
acctx providers                  # what each provider stores, where, and how acctx handles it
acctx providers github           # full explanation for one provider, with the paths on this machine
acctx rename vercel work client  # renames; the active pointer follows
```

`acctx list` output:

```
Vercel
  ● work     octocat-at-acmeinc  team team_Ab12Cd…Kl12  active · 2m ago
    octocat                      team team_Mn34Op…Wx34  3h ago

Convex
  no profiles yet · acctx add convex <name>
```

Colors are used only on a terminal and honor `NO_COLOR` / `FORCE_COLOR`.

## Providers

| id | stores | login via acctx | identity check |
|---|---|---|---|
| `vercel` | `$XDG_DATA_HOME/com.vercel.cli/{auth.json,config.json}` | isolated (`--global-config`) | `vercel whoami`; offline `userId` fingerprint |
| `convex` | `~/.convex/config.json` | in place (`npx convex login`) | one read-only call to the Convex API (no CLI whoami) |
| `github` | `$GH_CONFIG_DIR/hosts.yml` | isolated (`GH_CONFIG_DIR`) | `gh auth status` / `gh api user`; offline `user:` fingerprint |
| `supabase` | `~/.supabase/access-token` | in place (`supabase login`) | `supabase whoami` with the token passed as an env var |
| `cloudflare` | `$XDG_CONFIG_HOME/.wrangler/config/default.toml` | isolated (`XDG_CONFIG_HOME`) | `wrangler whoami` on a staged copy |
| `clerk` | OS keyring entry `clerk-cli/oauth-access-token` (+ `config.json`) | in place (`clerk auth login`) | Clerk OAuth userinfo, refreshing expired sessions; offline `userId` fingerprint |

`acctx providers <id>` prints the full explanation: the exact files, how a new
login is obtained, how identity is checked, which environment variables make
the CLI ignore the file (acctx warns when one is set), caveats such as OS
keyring storage, and what has actually been verified against the real CLI.

## How it works

A profile is a copy of the provider CLI's own credentials, kept under
`$XDG_CONFIG_HOME/acctx/profiles/<provider>/<name>/` with `0700`/`0600`
permissions. `use` first re-captures the live files into the active profile
(Vercel rotates refresh tokens, so a one-time snapshot would go stale), then
atomically writes the target profile's files into the CLI's real location. No
environment variables or shell aliases are needed: every tool that shells out
to `vercel` sees the switched account.

Providers whose CLI keeps the login in an OS keyring rather than a file (Clerk)
implement a small live-store adapter: acctx reads and writes the keyring entry
through the platform tools (`keyctl` or `secret-tool` on Linux, `security` on
macOS), passing the secret over stdin, never as an argument.

Vercel logins for `add` happen in an isolated directory via
`vercel login --global-config`, so the active login is untouched until you
`use` the new profile. Convex has no such flag, so `add convex` stashes the
current login into its profile first and then runs `npx convex login`.

## Security

- Tokens are never accepted as arguments and never printed; error output is
  passed through a redactor.
- acctx makes no network requests of its own, with one documented exception:
  the Convex CLI has no `whoami`, so labeling and checking a Convex profile
  makes a single read-only request to Convex's own API (`api.convex.dev`,
  list teams) with that profile's token. Everything else goes through the
  provider's CLI as a child process you can see.
- Zero runtime dependencies.
- `use` refuses to overwrite a live login that is not saved in any profile,
  and refuses to capture a login into the active profile when an offline
  fingerprint (Vercel: `userId`) shows it belongs to a different account, for
  example after a `vercel login` made outside acctx. Pass `--discard` to
  override either check. Convex has no non-secret identifier, so that second
  check does not apply to it. `remove` deletes the local copy only; run the
  provider's `logout` first if you want the token revoked.

## Status

Exercised against real CLIs on Linux: Vercel and Convex end to end with two
accounts each (add, use, check, rename, remove); GitHub and Supabase for
import, check, list and use with a cloned profile (their login flows were not
run); Cloudflare only for the config location and the logged-out `whoami`
path, so its add/check/use are unverified; Clerk for import, check, list and
use with a cloned profile on the Linux kernel-keyring backend (secret-service
and macOS Keychain paths unexercised, login flow not run). Each provider's `verified` line in
`acctx providers <id>` says the same.

## Install

```bash
pnpm install && pnpm build && pnpm link --global
```

## Adding a provider

Implement the `Provider` interface in `src/providers/<id>.ts` (list the
credential files, say whether a fresh login can be isolated, optionally give a
human label) and add it to `src/providers/index.ts`. Convex is about 40 lines.

## Development

```bash
pnpm test
```
