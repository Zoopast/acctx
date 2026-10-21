# acctx

Switch between accounts for developer CLIs. Vercel and Convex are supported;
adding a provider is one small file.

```
acctx import vercel personal     # save the account you are logged into right now
acctx add vercel work            # log into another account (Vercel's own device flow)
acctx use vercel work            # switch — `vercel whoami` now reports "work"
acctx use                        # interactive picker
acctx list                       # grouped by provider; --json for scripts
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

## How it works

A profile is a copy of the provider CLI's own credential files, kept under
`$XDG_CONFIG_HOME/acctx/profiles/<provider>/<name>/` with `0700`/`0600`
permissions. `use` first re-captures the live files into the active profile
(Vercel rotates refresh tokens, so a one-time snapshot would go stale), then
atomically writes the target profile's files into the CLI's real location. No
environment variables or shell aliases are needed: every tool that shells out
to `vercel` sees the switched account.

Vercel logins for `add` happen in an isolated directory via
`vercel login --global-config`, so the active login is untouched until you
`use` the new profile. Convex has no such flag, so `add convex` stashes the
current login into its profile first and then runs `npx convex login`.

## Security

- Tokens are never accepted as arguments and never printed; error output is
  passed through a redactor.
- acctx makes no network requests. Only the provider's CLI does, as a child
  process you can see.
- Zero runtime dependencies.
- `use` refuses to overwrite a live login that is not saved in any profile,
  and refuses to capture a login into the active profile when an offline
  fingerprint (Vercel: `userId`) shows it belongs to a different account, for
  example after a `vercel login` made outside acctx. Pass `--discard` to
  override either check. Convex has no non-secret identifier, so that second
  check does not apply to it. `remove` deletes the local copy only; run the
  provider's `logout` first if you want the token revoked.

## Status

Verified against the real Vercel CLI on this machine: import, identify,
switching between profiles, and the isolated-directory login mechanism. Not
yet verified: `add vercel` with a second account, and every Convex flow (the
Convex CLI was not installed here; its file layout comes from community
reports linked in the spec).

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
