---
name: acctx
description: Use before running vercel, convex, gh, supabase, wrangler, clerk or aws commands in a project that has a .acctx.json file. Verify the right accounts are active with `acctx status`; switch with `acctx use`. Also use when asked which account a project uses or to set one up.
---

# acctx: use the project's accounts

acctx switches the logins of developer CLIs (Vercel, Convex, GitHub, Supabase, Cloudflare Wrangler, Clerk, AWS). A project declares which accounts it uses in `.acctx.json` at its root. Your job is to make sure those accounts are active before you run any of those CLIs.

## Before running a provider CLI

1. If the project has `.acctx.json`, run:
   ```bash
   acctx status --json
   ```
   Do this before the first `vercel`, `convex`, `gh`, `supabase`, `wrangler`, `clerk` or `aws` command of the session, and again after anything that could have changed a login.
2. If `"ok": false`, run `acctx use`, then `acctx status --json` again. Show the user both outputs.
3. If `acctx use` refuses (an unsaved login, a different account, an unresolved entry), stop and tell the user what it said. Do not work around it.

## Rules

- Never pass `--discard`, `--force` or `-y` to acctx on the user's behalf. Those destroy or overwrite logins; only the user decides.
- Never print, copy or move credential files. acctx never prints tokens; neither should you.
- acctx covers CLI logins only. MCP servers and IDE plugins for the same providers authenticate separately; `acctx status` says nothing about them.
- `acctx status` is offline and safe to run as often as needed. Exit code 0 means every entry is `ok`.

## Status states

`ok`, `inactive` (saved but not the active login), `logged-out`, `unresolved` (no local profile matches), `ambiguous` (several match), `override` (an env var like `VERCEL_TOKEN` is set and the CLI will ignore the switched login). Each JSON entry carries a `hint`.

## File format (`.acctx.json`, committed, no secrets)

```json
{
  "vercel":  { "account": "dev@acme.com" },
  "convex":  { "tag": "work" },
  "github":  "octocat"
}
```

Keys are provider ids. A value is a local profile name, or an object with any of `profile` (local name), `account` (the login's email/username), `tag` (a local tag set with `acctx tag <provider> <name> <tag>`). All given fields must match one local profile.

## Setting a project up

`acctx init` (interactive) or `acctx init --from-active`. Add `--shared` to pin by account for a team. `acctx list` shows the saved profiles; `acctx add <provider> <name>` logs into a new one.
