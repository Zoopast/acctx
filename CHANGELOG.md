# Changelog

## 0.1.0

First release.

- Switch saved profiles for Vercel, Convex, GitHub, Supabase, Cloudflare
  Wrangler and Clerk: `add`, `import`, `use`, `list`, `current`, `check`,
  `rename`, `remove`, `providers`.
- Per-project pinning with a committed `.acctx.json` (`profile`,
  `account`, `tag` selectors): `init`, `status`, `use` with no arguments,
  `tag`/`untag`.
- AI-agent skill shipped in `skills/acctx/SKILL.md`, installable with
  `acctx skill install`, plus an optional Claude Code PreToolUse hook
  (`acctx guard`).
