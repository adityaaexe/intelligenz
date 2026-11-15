# Threat model

What this software defends against, what it does not, and why.

## Assets

1. **The run record** — an accurate ordered account of what an agent did.
2. **Its integrity** — the ability to prove the record was not edited afterwards.

## Adversaries

| Adversary | Capability | Motivated by |
|---|---|---|
| **Lazy falsifier** | Edits one field or deletes one line in a finished journal | Hiding a bad tool call or an error |
| **Careful falsifier** | Rewrites an entry and recomputes every downstream hash | Same, with tooling |
| **Storage compromise** | Full write access to the journal file, or to the disk | Covering tracks |
| **Framework author** | Controls what the application appends | Producing a self-serving record |

## Covered

**Edit, delete, insert, reorder without re-chaining.** Detected by
`verifyJournal`, which recomputes every hash and checks `seq` continuity and
`prev` linkage. A single changed byte produces a mismatch at a known sequence
number.

**Full re-chain.** Not detectable by `verifyJournal` — a rewritten chain is
internally consistent by construction. Detected by `verifyAnchor` **provided an
anchor was published somewhere the adversary does not control.**

Verified behaviour, from the test suite and the CLI:

```
# attacker edits entry 1 and recomputes 4 hashes
$ intelligenz verify run.jsonl
OK 5 entries, chain intact          ← the chain cannot know

$ intelligenz verify run.jsonl --anchor anchor.json
ANCHOR MISMATCH: anchored prefix was rewritten: entry 3 hashes to 07f9…  ← caught
```

**Truncation.** Removing trailing entries leaves a shorter but valid chain.
`verifyJournal` accepts it (a shorter valid journal is still valid);
`verifyAnchor` rejects it because the anchored prefix is incomplete.

**Backdating a fresh journal.** Anchoring an empty journal commits to the genesis
head, so entries cannot later be presented as having existed at anchor time.

## Not covered

These are real limits, not caveats for form's sake.

1. **No anchor, no protection against re-chaining.** Without a published anchor,
   the careful falsifier wins. The software provides the mechanism; publishing is
   the operator's responsibility.
2. **No signatures, no identity.** Nothing here proves *who* wrote an entry. An
   anchor can be published by anyone. Authenticity needs a signature scheme,
   which is not implemented.
3. **A trusted clock is not available.** `ts` is whatever the writer's clock said.
   Anchors do not fix this; an attested timestamp from a third party would.
4. **A malicious writer can simply not record an event.** Journals prove what is
   in them and that it was not altered. They prove nothing about completeness.
   Absence of a `tool.call` is not evidence that no tool was called.
5. **Payload contents are not inspected.** Secrets, PII, or prompt text written
   into a payload land in the journal verbatim. Redaction is the caller's job,
   and redaction after the fact breaks the chain by design.
6. **No protection against a compromised dependency.** If an attacker controls the
   process that calls `append`, they can write whatever they like.

## Deployment guidance

- Publish anchors somewhere append-only: a Git commit, a release asset, a
  transparency log, or a separate system with different credentials.
- Do not store the anchor beside the journal. An adversary with disk write access
  to the journal almost certainly has it for a neighbouring file.
- Anchor at the end of a run, and again before handing the record to anyone who
  might dispute it.
- Treat the journal as sensitive: it contains tool arguments and results, and
  often user text.

## Why no `!important`-style escape hatch

There is deliberately no `--force` flag on verification and no option to skip
checks. A verification tool that can be talked out of verifying is not a
verification tool.
