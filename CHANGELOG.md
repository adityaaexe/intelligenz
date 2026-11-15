# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-15

### Added

- **Anchors.** `createAnchor`, `readAnchor`, `verifyAnchor`, and the
  `intelligenz anchor` CLI command produce a small document committing to a
  journal's head (`{ version, entries, head, at }`).
- `verify --anchor <file>` checks a journal against an anchor. It accepts entries
  appended after anchoring and rejects a rewritten or truncated prefix.
- `docs/FORMAT.md` — normative description of the entry format, hash preimage,
  canonicalisation rules, and anchor semantics.
- `docs/THREAT-MODEL.md` — covered and uncovered adversaries, with the
  re-chaining attack demonstrated.
- Nine anchor tests, including a forged-but-re-chained journal.

### Changed

- CLI argument parsing now supports `--flag value`, so `verify` and `anchor`
  accept options. Positional parsing is unchanged for existing commands.
- `--help` documents exit codes: `0` success, `1` verification failure,
  `2` usage error.

## [0.1.0] — 2026-11-15

### Added

- Hash-chained, append-only NDJSON journal (`Journal.create`, `Journal.open`,
  `Journal.append`).
- `verifyJournal` — detects edited fields, deleted entries, inserted entries, and
  reordering.
- `replay` — re-drives a journal in order and refuses an unverified one.
- CLI: `verify`, `head`, `tail`, `replay`.
- Closed eight-event vocabulary; plain-object payloads only.
- Sixteen tests.
- Zero runtime dependencies; Node 22+.
