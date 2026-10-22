# Security policy

acctx moves developer-CLI credentials between saved profiles and the live
locations the CLIs read. It never sends credentials anywhere, never prints
them, and only reaches the network to ask a provider "who am I" with the
credentials you already have.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report privately
through GitHub's "Report a vulnerability" form on this repository
(Security tab), or email the maintainer listed in `package.json`.

You can expect an acknowledgement within a few days. Please include the
acctx version, your OS, the provider involved, and reproduction steps.
Do not include tokens or credential files in a report.

## Scope

In scope: anything that leaks, prints, uploads, or silently overwrites a
credential; anything a cloned `.acctx.json` or an installed skill/hook can
do beyond selecting an existing local profile; permission regressions on
files acctx writes.

Out of scope: the providers' own CLIs and APIs, and the shell-tokenizer
limits of `acctx guard`, which is a safety net for AI agents rather than a
sandbox.
