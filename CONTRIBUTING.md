# Contributing

Thanks for helping. acctx is small on purpose: zero runtime dependencies,
TypeScript with `strict` on, Node's built-in test runner.

## Setup

```bash
pnpm install
pnpm test        # builds, then runs node --test
npm link         # optional: makes `acctx` point at this checkout
```

## Ground rules

- No runtime dependencies. If a feature needs one, open an issue first.
- Never print tokens, never accept tokens as arguments. Secrets travel by
  stdin or env only. See `src/core/redact.ts`.
- Every command that writes credentials must keep the sync-then-swap
  guards in `src/core/switcher.ts`.
- Tests go in `test/` next to the code they cover and run against real
  files in a temp directory, not mocks of the store.

## Adding a provider

Implement the `Provider` contract in `src/providers/types.ts`, register it
in `src/providers/index.ts`, add a test, and document how its login is
stored in the `storage` field. The README's "Adding a provider" section
walks through it.

## Releasing

Bump `version` in `package.json`, update `CHANGELOG.md`, commit, then
create a GitHub release with tag `v<version>`. The publish workflow runs
the suite and stages the version on npm with provenance (Trusted
Publishing, no token). A maintainer then approves it with 2FA, either in
the package's Staged Packages tab on npmjs.com or with
`npm stage approve <stage-id>` (`npm stage list acctx` prints the id).
