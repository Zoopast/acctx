# acctx — project config, status, and agent skill

Date: 2026-10-21. Extends `2026-10-21-account-switcher-design.md`.

## Intent

A project should be able to declare which accounts it belongs to, so that a
developer or an AI agent working in that project can verify and apply the
right logins before running `vercel`, `convex`, `gh`, `supabase`, `wrangler`
or `clerk`. The package will be published on npm, so the file must work for a
team sharing a repo: teammates have different local profile names, some
accounts are shared (a team dev account), some are personal (each dev's own
work login).

Three deliverables:

1. A committed project file, `.acctx.json`, that names accounts without
   secrets.
2. Commands: `init`, `status`, project-mode `use`, `tag`/`untag`,
   `skill install`, and a hidden `guard` for Claude Code hooks.
3. A skill (`skills/acctx/SKILL.md`) that tells agents to check before
   touching provider CLIs, laid out so `npx skills add <repo>` finds it, and
   installable by acctx itself at project or global scope.

## Assumptions (correct me)

- JSON, not TOML or YAML: zero runtime deps stays a rule.
- The file lives at the repo root by default (`acctx init` writes to the
  current directory). Nested files in a monorepo are allowed and the nearest
  wins.
- acctx governs CLI logins only. MCP servers and editor plugins (Vercel MCP,
  Convex plugin) authenticate on their own; the skill says so.
- No automatic switching on `cd`. Switching replaces live credentials for
  every terminal and stays an explicit command.
- Hooks are Claude Code only for now (`PreToolUse` on `Bash`). Other agents
  get the skill text.

## The project file: `.acctx.json`

```json
{
  "$schema": "https://acctx.dev/schema.json",
  "vercel":  { "account": "dev@acme.com" },
  "convex":  { "tag": "work" },
  "github":  { "profile": "zoopast", "account": "zoopast" },
  "supabase": "gravita"
}
```

Rules:

- Top-level keys are provider ids known to this acctx build, plus an
  ignored `$schema`. Any other key is an error naming the key and the known
  ids.
- A value is a string (shorthand for `{ "profile": "<string>" }`) or an
  object with at least one of:
  - `profile`: a local profile name (profile-name regex,
    `^[a-z0-9][a-z0-9._-]{0,63}$`, case-insensitive).
  - `account`: the identity label acctx stored for the profile (email,
    username). Compared case-insensitively. Printable, at most 256 chars,
    no whitespace other than inner spaces.
  - `tag`: a tag the developer attached locally with `acctx tag`. Same regex
    as profile names.
  - Unknown object keys are an error.
- Each given field is a selector. The entry resolves to the one local
  profile that matches every selector. Zero matches: `unresolved`. Two or
  more: `ambiguous`, listed by name. This is how one file serves a shared
  dev account (`account`), each dev's own work account (`tag`), and a
  personal machine (`profile`).
- The file holds no secrets, so 0644 is fine and it is the only acctx file
  meant to be committed. It cannot reference paths, env vars, flags or
  commands; nothing in it can be executed, and nothing in it can create a
  profile. It can only pick among profiles that already exist locally.
- Treat it as untrusted (it arrives with a clone). Parse with strict JSON,
  reject files over 64 KiB, reject non-regular files, and never follow it
  into any side effect other than selecting a local profile.

Discovery: starting at the current directory, walk upward looking for
`.acctx.json`. Stop after examining a directory that contains `.git`
(the repo root), and never examine `$HOME` or anything above it. The
filesystem root is also a stop. The nearest file wins.

## Tags (local, per profile)

`ProfileMeta.tags?: string[]`. Commands:

- `acctx tag <provider> <name> <tag> [tag...]` adds tags (idempotent).
- `acctx untag <provider> <name> <tag> [tag...]` removes them.
- `acctx list` shows tags dimmed after the label; `--json` includes them.

Tags are local metadata, never shared, never secrets.

## Commands

### `acctx init [--shared] [--from-active] [--force] [--yes]`

Writes `.acctx.json` in the current directory. Refuses to overwrite an
existing file unless `--force`.

- Interactive: for each provider that has at least one profile, show the
  arrow picker with the profiles plus a final "skip" entry. Providers with no
  profiles are skipped with a dim note.
- `--from-active`: take the active profile of each provider, no prompts.
- Selector written per picked profile: `profile` by default (personal
  machine). With `--shared`, or when the interactive opening question
  "Who will use this file? (just me / my team)" answers team, write
  `account` when the profile has an identity label, else `profile` with a
  warning that teammates will have to adapt it.
- After writing, when interactive, ask once: "Install the acctx skill for
  AI agents? (project / global / skip)" and run the equivalent of
  `acctx skill install [--global]`. `--yes` picks project. Non-interactive
  without `--yes` installs nothing.
- Output: the written file path and its entries; a hint for
  `acctx status`.

### `acctx status [--json]`

Offline. Reads the project file and reports one line per entry:

| state | meaning | hint |
|---|---|---|
| `ok` | resolved profile is active and the live fingerprint equals the profile's (or the provider has no fingerprint and the live login exists) | |
| `inactive` | resolved profile exists but is not the active one, or live fingerprint differs | `acctx use` |
| `logged-out` | resolved profile exists and is active, but no live login | `acctx use` |
| `unresolved` | no local profile matches the selectors | `acctx add <p> <name>` then `acctx tag`/rename as needed |
| `ambiguous` | several profiles match | list; refine the file or tags |
| `override` | provider override env var set | unset it |

Exit code 0 only when every entry is `ok`. Otherwise 1. No project file:
error with hint `acctx init`, exit 1.

`--json`: `{ "file": "<abs path>", "ok": boolean, "entries": [ { "provider",
"selector": {...}, "profile": string|null, "label": string|null, "state",
"candidates": string[] (ambiguous only), "hint": string|null } ] }`. Keys are
stable; agents depend on them.

### `acctx use` (no arguments) in a project

If a project file is found: resolve every entry, print the plan
(`vercel  personal → work (dev@acme.com)`), then apply in file order with
the existing `Switcher.use`, which keeps every guard (unsaved live login
refuses unless `--discard`, fingerprint mismatch refuses). Entries that are
already `ok` are skipped. Entries `unresolved`/`ambiguous`/`override` are
reported, not applied. Failures do not stop later entries. Exit 1 if any
entry failed or was not applied.

If no project file is found, the current picker runs. `acctx use --pick`
forces the picker even in a project. `acctx use <provider>` and
`acctx use <provider> <name>` are unchanged.

Flags come only from the command line. Nothing in the file can set
`--discard`.

### `acctx skill install [--global] [--agent <id>[,<id>]] [--hook] [--force] [--yes]` and `acctx skill show`

The skill ships in the package at `skills/acctx/SKILL.md` (frontmatter:
`name: acctx`, `description`), which is the layout `npx skills add
<owner>/<repo>` discovers. `package.json` `files` includes `skills`.

Install targets (from the vercel-labs/skills agent table):

| agent id | project | global |
|---|---|---|
| `claude-code` | `.claude/skills/acctx/SKILL.md` | `~/.claude/skills/acctx/SKILL.md` |
| `universal` | `.agents/skills/acctx/SKILL.md` | `~/.config/agents/skills/acctx/SKILL.md` |
| `cursor` | `.agents/skills/acctx/SKILL.md` | `~/.cursor/skills/acctx/SKILL.md` |
| `codex` | `.agents/skills/acctx/SKILL.md` | `~/.agents/skills/acctx/SKILL.md` |

Default agents: `claude-code,universal`. Project scope writes into the
current directory. Global writes under `$HOME`; when interactive it confirms
first, when not it requires `--yes`. An existing file with different content
is overwritten only with `--force` or a confirmation. Files are written
atomically, mode 0644, directories 0755 (these are not secrets).

`--hook` (Claude Code only) merges a `PreToolUse` hook into
`.claude/settings.json` (project) or `~/.claude/settings.json` (global):

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "acctx guard" } ] } ] } }
```

Merge rules: read the existing JSON (must parse; otherwise refuse), add the
entry if an identical `acctx guard` command is not already present, write
atomically preserving other keys. Tell the user what was added and how to
remove it.

`acctx skill show` prints the SKILL.md to stdout for any other agent.

### `acctx guard` (hidden; Claude Code PreToolUse hook)

Reads the hook JSON from stdin. If `tool_name` is not `Bash`, or
`tool_input.command` does not invoke a provider CLI (first word of any
pipeline segment, after optional `npx`/`pnpm dlx`/`bunx`, equals one of the
provider CLI names: `vercel`, `convex`, `gh`, `supabase`, `wrangler`,
`clerk`), exit 0. The `cwd` field from the hook payload is where discovery
starts. If no project file is found, exit 0 (projects that do not opt in
are unaffected). Otherwise run the status check; if every relevant entry
(the providers whose CLI the command invokes) is `ok`, exit 0; else print
the status lines and `Run: acctx use` to stderr and exit 2, which blocks the
tool call. Any internal error also exits 2 with the error (fail closed) and
the hint to remove the hook from `.claude/settings.json`.

## The skill text (`skills/acctx/SKILL.md`)

Frontmatter `name: acctx`, `description: Use before running vercel, convex,
gh, supabase, wrangler or clerk commands in a project that has .acctx.json:
verify the right accounts are active with acctx status, switch with acctx
use.` Body, short:

1. If the project has `.acctx.json`, run `acctx status --json` before the
   first provider CLI command of the session and again after anything that
   could have changed logins.
2. If `ok` is false, run `acctx use`, then `acctx status --json` again.
   Show the user the output.
3. Never pass `--discard`, `--force` or `-y` to acctx on the user's behalf.
   If acctx asks for one of them, stop and ask the user.
4. Never print or copy credential files; acctx never prints tokens either.
5. acctx covers CLI logins only. MCP servers and IDE plugins for the same
   providers authenticate separately.
6. To set a project up: `acctx init`. To see the file format: this skill's
   "File format" section (a compact copy of the schema above).

## Security rules (added)

- The project file is untrusted input. It can only select existing local
  profiles. Strict schema, size cap, regular-file check.
- `status` and `guard` are offline: no network, no process spawning except
  nothing. They read `state.json`, profile metadata, and live files for
  fingerprints only.
- `init` and `skill install` write only non-secret files. Global writes
  need confirmation or `--yes`.
- `guard` fails closed on internal errors and open when the project has no
  file.
- Package publishing: `package.json` must not carry the `link:` self
  dependency left by `npm link`; `files` is `dist` and `skills`.

## Error handling

All user-facing failures are `UserError` with a hint. A malformed project
file reports the path and the exact problem (unknown key, bad selector).
`use` in project mode continues past per-provider failures and summarizes.

## Testing

- `test/project.test.ts`: discovery (nearest wins, stops at git root, never
  reads `$HOME`), parse/validate (shorthand, unknown provider, unknown
  field, bad selector, size cap), resolution (profile, account
  case-insensitive, tag, combined, unresolved, ambiguous).
- `test/status.test.ts`: every state with the fake provider, exit codes,
  JSON shape.
- `test/use-project.test.ts`: plan output, skip when ok, continue past a
  failure, `--pick` fallback.
- `test/init.test.ts`: `--from-active`, `--shared` writes `account`,
  refuses overwrite without `--force`.
- `test/skill.test.ts`: install paths for each agent and scope, no
  overwrite without `--force`, hook merge preserves other keys and is
  idempotent, `show` prints the file.
- `test/guard.test.ts`: non-Bash exits 0, unrelated commands exit 0,
  `npx vercel deploy` with mismatch exits 2, no project file exits 0.
- `test/tags.test.ts`: tag/untag idempotent, list shows tags.

## Out of scope

- `acctx run <cmd>` with per-process isolation (Convex cannot).
- Shell `cd` hooks.
- Hooks for agents other than Claude Code.
- A hosted JSON schema (the `$schema` key is accepted and ignored).
