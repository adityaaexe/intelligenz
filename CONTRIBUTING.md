# Contributing

Thanks for looking. This is a small project with a deliberately narrow scope, so
the fastest route to a merged change is a focused one.

## Getting started

```bash
git clone https://github.com/adityaaexe/run-journal.git
cd run-journal
npm ci
npm test
```

`npm test` builds with `tsc` and then runs the suite with `node --test`. There is
no bundler, no transpiler step beyond TypeScript, and no runtime dependency to
install.

## Ground rules

- **Zero runtime dependencies.** This is a constraint, not a preference. Node's
  standard library is the dependency budget. A PR that adds a runtime dependency
  needs a very good reason.
- **No `--force` on verification.** Verification must not be skippable by a flag.
  If a check is wrong, fix the check.
- **No silent fallbacks.** If a journal is malformed, throw. Do not skip bad
  lines, do not guess, do not "repair" during verification.
- **The format is versioned.** Changing the hash preimage is a breaking change to
  every existing journal. Propose it in an issue first.

## What a good PR looks like

1. An issue or a short description explaining the problem, not the patch.
2. A test that fails before the change and passes after it.
3. `npm test` green locally.
4. No unrelated formatting churn — the diff should be readable.
5. If behaviour changes, `CHANGELOG.md` updated and `docs/FORMAT.md` or
   `docs/THREAT-MODEL.md` updated when the change is security-relevant.

## Scope

In scope: correctness of the chain, replay fidelity, the anchor protocol,
performance on large journals, additional verification ergonomics.

Out of scope for now: framework auto-instrumentation, a server, a UI, cloud
storage, signatures (see `docs/THREAT-MODEL.md` for why they are absent rather
than forgotten).

## Reporting bugs

Open an issue with the version (`run-journal --version`), the smallest journal
that reproduces it, and the command you ran. A redacted three-line journal is
worth more than a paragraph of description.

Security issues should not be filed publicly — see [SECURITY.md](SECURITY.md).
