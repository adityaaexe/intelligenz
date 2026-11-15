# Artifact integrity — adversarial tests

**Gate:** G · **Suites:** `packages/workspace-manager/test/{change-manifest,hostile-repository,snapshot}.test.ts`, `apps/worker/test/evidence-{capture-order,capture-points,provenance}.test.ts`
**Result recorded:** `TEST-RESULTS.md`. The independent review exists and returns **FAIL** for
Gate G; counts are not restated here.

**Corrected under D-602.** The traversal table below used to read as a list of exercised
behaviours. Three of its rows were code paths with no test, and one named a check that does not
detect what the row claimed. The table now has an *Exercised by* column: a row that no test
covers says so.

## Why these tests exist

The three attacks below were measured against the *existing* pipeline before any fix — in a
scratch repository, against the exact command shape `collectWorkspaceEvidence` used. A test
that asserts "the manifest has entries" proves nothing. Each test here names an attack, and
each has a **positive control** showing the attack is real.

## The three measured attacks

### Attack 1 — staging

`change-manifest.test.ts:57` — *"a staged change: `git diff` is empty, the tree is not"*

| | |
|---|---|
| Attack | modify a file, `git add -A` |
| Observed pre-fix | `git diff` → **0 hunks**; tree fully changed; only a ` M` status line survives |
| Property | the manifest reports a real modification with the bytes **on disk** |
| Assertion | `status === 'modified'` and `after.sha256 === sha256(newBytes)` |
| Would fail if | evidence were derived from `git diff` in any form |

### Attack 2 — clean filter

`change-manifest.test.ts:106` — *"a clean filter: git sees the index, the disk holds something else"*

| | |
|---|---|
| Attack | `.gitattributes` → `filter.hide.clean = sed s/COMPROMISED/original/` |
| Observed pre-fix | `git diff` → **0 lines** while the file on disk reads `SECRET=COMPROMISED` |
| Why `--no-textconv` does not help | textconv is a *diff driver*; clean/smudge are *filters*. Neutering one leaves the other |
| Property | the manifest hashes the bytes on disk, never the filtered view |
| Assertion | hash equals `sha256('SECRET=COMPROMISED\n')`, explicitly *not* the pre-image |

### Attack 3 — commit (the dangerous one)

`change-manifest.test.ts:161` — *"a committed change: the tree is clean and entirely different"*

| | |
|---|---|
| Attack | `git add -A && git commit` |
| Observed pre-fix | `git status` → **0 lines**, `git diff` → **0 lines**, tree entirely replaced |
| Why it matters most | not a tampering *signal*, a confident **negative** — the artifact asserts "nothing changed" |
| Property | the manifest is non-empty and correct while both git views say nothing |
| Assertion | `changes.length > 0` and the modified path carries the new hash |

## Hostile repository fixture

`hostile-repository.test.ts:132-269`. One fixture arms every helper the old path could have
executed: a textconv program, an external diff driver, a `clean` filter, a `core.fsmonitor`
command and `post-checkout` / `pre-commit` / `pre-push` hooks. Each writes a marker file
**outside** the tree.

| Test | What it proves |
|---|---|
| `:133` "takes a complete snapshot pair and a correct manifest while every hostile program stays dormant" | the marker directory is **empty** — not one helper ran. Also asserts the real changes are all present, the ` /etc/passwd` symlink is recorded as a link with that target and never read, and the binary file is hashed |
| `:243` **positive control** — "the trap is armed: the same helper does run when a git command is invoked" | the fixture genuinely catches execution. Without this, `:133` would pass on a fixture that could never have fired |
| `:269` "detects a file modified after the manifest was built" | the digest is an instant, not a promise about the future |

The positive control is the part most suites omit, and it is the only thing that makes the
negative assertion meaningful.

## Traversal and consistency

| Attack | Where | Behaviour | Exercised by |
|---|---|---|---|
| symlink to `/etc/passwd` | `hostile-repository.test.ts:133` | recorded as `symlink` + target string; target never opened; `/etc/passwd`'s digest absent from body and manifest | `hostile-repository.test.ts:133` |
| path escape `..` / absolute | `isContained` throw | `SNAPSHOT_PATH_ESCAPE`, walk aborts | **No test.** The walk's own name filter (`.`/`..`/separator) makes the throw defensive; nothing reaches it |
| symlinked root | `snapshot.ts:912` | rejected | `snapshot.test.ts:264` (file and symlink root) |
| directory vanishes mid-walk | `walk`, `ENOENT` branch | `stopReason: 'unreadable'`, not ignored | **No test deletes a queued directory.** Code path only |
| file changes during read | `hashRegularFile` (`snapshot.ts:301` at `cfc1f26`) | `size` + `mtimeMs` re-read after hashing; a size change or an `mtime`-moving rewrite makes the entry `unstable`. A same-size rewrite with `mtime` restored is **not** detected at `cfc1f26`; the working tree adds `ctimeMs` (uncommitted) | `snapshot-race.test.ts:54` (stale `lstat`/swap), `:89` (size change), positive control `:74`; `:140`, `:175` for `ctimeMs` (uncommitted) |
| a name that is not valid UTF-8 | `walk`, `lstat` `ENOENT` | walk stops, `stopReason: 'unreadable'`, the entry is absent, and every later manifest of that workspace is incomplete | **No test.** Measured by the reviewer (`FINAL-INDEPENDENT-REVIEW.md:2614-2623`) |
| awkward names (spaces, unicode, newline) | `hostile-repository.test.ts:133` | carried, byte-sorted | `hostile-repository.test.ts:133`; ordering at `snapshot.test.ts:160` |
| empty directory | `change-manifest.test.ts:215` | covered by the status contract | `change-manifest.test.ts:215` |

This table used to name a "size-vs-bytes check" as the detector of a file changing during the
read. That check (`snapshot.ts:347` at `cfc1f26`) detects a **short read** — fewer bytes hashed
than the descriptor claims — not a content mutation. It is row 4 of "Consistency during
capture" in `TRUSTED-SNAPSHOT-DESIGN.md`, and no test produces a short read either.

## Bounded work is not authority

| Test | Assertion |
|---|---|
| `change-manifest.test.ts:304` | hitting the change cap sets `complete: false` with a stop reason |
| `change-manifest.test.ts:330` | either snapshot bounded ⇒ manifest `complete: false` |
| `evidence-provenance.test.ts:667` | a **bound** workspace with an incomplete walk ⇒ `Artifact.authoritative === false` |
| `evidence-provenance.test.ts:437` | an envelope claiming `authoritative: true` over an incomplete body is refused |
| `persist-result.ts:365` | `authoritative = evidence.authoritative && workspaceId !== null` |

A truncated manifest is written and is **never** authoritative. The first two rows prove
`complete: false`; the authority claim itself is proven by the two `evidence-provenance` rows.
This section used to cite only `change-manifest.test.ts:304,330` and `persist-result.ts:354` for
the authority property: those tests would stay green if the authority gate were deleted, and
`:354` no longer resolves to the gate.

## Determinism

`change-manifest.test.ts:347` recomputes the digest from the stored body and asserts
equality; a second assertion edits one byte and asserts the digest changes. Sorting is
`Buffer.compare` on path bytes rather than `Array.sort`, because UTF-16 ordering mis-orders
astral characters and would make one tree hash differently on two hosts.

## Ordering

`evidence-capture-order.test.ts:58` asserts source positions in `execute-agent.ts`:
`baseline > leaseAcquired`, `baseline < cgroup`, `baseline < markExecuting`,
`baseline < execute`, and that `execute` has exactly one call site. `:89` asserts a
sandboxed write is reported as `added` (not laundered as pre-existing) while a file that was
already present in a reused workspace is *not* reported — the per-attempt semantics that make
workspace reuse safe.

## Honest gaps in this suite

1. **Mount crossings are not attempted.** No test creates a mount inside the workspace, so
   the "walked as directories and files" policy is unexercised.
2. **Hard links** are hashed per path; no test asserts the inode double-count behaviour.
3. **A file modified after the final snapshot but before persistence** is not covered — the
   manifest is an instant, and its hash is verified against the stored body
   (`verifyManifestFile`), not re-derived from the tree.
4. **A parent directory swapped for a link** between its `readdir` and a child's `lstat` is
   not detected at `cfc1f26`, and no test attempts it. Measured by the reviewer; named
   limitation 9 in `TRUSTED-SNAPSHOT-DESIGN.md`.
5. **`providerMeta`-supplied workspace provenance** was an open defect found during the
   Gate G audit; the correction and its test are recorded separately in the final report.
6. **No signing.** A hash proves the bytes have not changed since the host wrote them. It
   does not prove who wrote them; there is no key and no signature.

## How to run

```bash
npx vitest run packages/workspace-manager/test/snapshot.test.ts \
  packages/workspace-manager/test/change-manifest.test.ts \
  packages/workspace-manager/test/hostile-repository.test.ts
npx vitest run apps/worker/test/evidence-capture-order.test.ts \
  apps/worker/test/evidence-capture-points.test.ts \
  apps/worker/test/evidence-provenance.test.ts
```

Hostile fixtures run only in disposable temporary directories. No hostile helper is ever
pointed at this repository.
