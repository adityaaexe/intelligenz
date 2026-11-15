# Trusted snapshot design

**Gate:** G · **Component:** `packages/workspace-manager/src/snapshot.ts`, `manifest.ts`
**Measured at:** `cfc1f26`. **Status:** the independent review exists and returns **FAIL** for
Gate G (`PHASE6-GATE-MATRIX.md` G-21, `FINAL-INDEPENDENT-REVIEW.md`). Test counts are in
`TEST-RESULTS.md` and are not restated here.

**Corrected under D-602.** This document was audited claim by claim (`DOC-CLAIM-AUDIT.md`).
Sentences that no test supports are now either backed by a named test or labelled
*not proven*. Corrections are listed at the end under "Corrections applied under D-602", so
the change is visible rather than silent.

**Line numbers.** A citation without a qualifier refers to `cfc1f26`, the commit the audit
measured. A citation marked *working tree* refers to the uncommitted tree, where
`snapshot.ts` has moved; those lines will move again when it is committed.

## The one-sentence design

The host walks the workspace filesystem with `lstat`, `readlink` and `readdir`, and hashes file
content through a descriptor — never through a program the repository can configure — into one
canonical body, and compares two such bodies into a change manifest. So the description of what
changed is produced by the process that observed the filesystem, not by a program the
repository can configure.

## Non-authoritative inputs

| Input | Why it is not authority |
|---|---|
| `git diff` / `git status` | A diff is relative to a pointer (`HEAD`, the index) the agent can move. `git add` empties it; `git commit` empties both halves. |
| `.git/config`, hooks, attributes | Agent-writable programs and configuration. |
| Clean/smudge filters | Apply to content as git compares worktree to index. `--no-textconv` does not disable them — different mechanism. |
| Adapter-reported checksum | Computed by the untrusted side, before the host copies anything. |
| Agent completion claim | A statement, not an observation. |

`.git` is still **read**, but only as metadata: `config` digest, `HEAD`, and (name, kind,
sha256) for every hook, under `SnapshotGitMetadata`. That answers "did the repository's own
control surface change", and it never substitutes for observing the tree. Only the **workspace
root's** `.git` is read this way. A `.git` at any other depth is not the root repository's
metadata; it is a directory the agent can write (see "Exclusions"). A `.git/hooks` that is a
symbolic link is recorded by its target (`hooksDirectoryLinkTarget`) and contributes **no**
hook entries: a link is a fact about the repository's control surface, and listing what it
points at would make that field a read primitive for the host filesystem
(`snapshot-escape.test.ts:63`).

## Traversal

| Property | Implementation | Line |
|---|---|---|
| `lstat` for classification, never `stat` | a path is classified without following the final link; the opened descriptor is `fstat`ed to confirm identity | `snapshot.ts:361` |
| Symlink target recorded as a string | `readlink`, hashed as `symlink:<target>` | `:391` |
| **Every directory is enumerated through one helper** | `listDirectory()` `lstat`s the path first; a symlink is recorded by target and **never listed**. Used for the content walk and for `.git/hooks`, because "do not descend through a link" is about descending, not about which directory. Proven for both consumers: `snapshot-escape.test.ts:63` (a symlinked hooks directory yields zero entries) and `snapshot.test.ts:109` (a content symlink is recorded and its target not read). | `:391` |
| Lexical containment of every path string | `isContained()` on every directory **and** every entry; throws `SNAPSHOT_PATH_ESCAPE`. This is a check on the string, not on its components: a path built from a symlinked parent passes it. No test reaches the throw — the walk's own name filter (`.`/`..`/separator) makes it defensive. | `:671`, `:713` |
| Contested entries are refused | `open(O_RDONLY \| O_NOFOLLOW)` + `fstat`; `dev`/`ino`/`size` compared with the `lstat` that classified the entry | `:301` |
| `realpath` deliberately **not** used | would follow exactly the symlinks the module refuses to | `:671` |
| **`.git` at the workspace root only** | The root's `.git` is skipped in the walk and described by `SnapshotGitMetadata`. A `.git` at any other depth is content and is walked like any directory. **Working tree, uncommitted, awaiting independent review**: `snapshot.ts:844` (working tree), test `snapshot-nested-git.test.ts` (untracked). At `cfc1f26` the exclusion was at every depth and only the root was described, which made a nested `.git` an undescribed write area (F-G11). | `:844` (working tree) |
| Definite git metadata is not read through links | `config`/`index`/`hooks` follow the same rule; `.git/HEAD` and `.git` itself are read with `O_NOFOLLOW` | `:433`, `:470` |
| Deterministic order | `Buffer.compare` on path bytes, not `Array.sort` (UTF-16 would mis-order astral characters) | `:221` |
| Deterministic truncation | sorted frontier, breadth-first. The order is deterministic by construction; **no test asserts that two hosts cut at the same entry** — `snapshot.test.ts:279` asserts the count and the `stopReason`. | `:690` |
| Root must be a real directory | rejects symlinked or non-directory root | `:912` |

## Entry model

`file` · `dir` · `symlink` — with `mode & 0o7777`, size, sha256 (regular files only), and
`symlinkTarget`. Directories carry `sizeBytes: 0, sha256: null` and are queued.

Breadth-first keeps the stack proportional to directory count rather than tree depth, and it
means a truncated snapshot contains the shallowest entries first: every top-level entry is
described as long as the cap allows one entry per top-level name. A cap smaller than that
number truncates at the same place in the sorted order, and reports `complete: false`.

## Consistency during capture

A file can change between `lstat` and the read that hashes it. Four things are checked, and
they are not the same check:

1. **The path is opened without following a link.** `O_NOFOLLOW` makes `open` fail (`ELOOP`)
   if the final component became a symlink after it was classified as a regular file. That
   swap is the `lstat` → `open` race, and it used to be resolved in the attacker's favour
   (`snapshot-race.test.ts:54`).
2. **The descriptor is the inode that was classified.** `fstat` is compared with the
   `lstat` result: different `dev`/`ino` or a different `size` is a contested entry, and a
   contested entry **fails** — it is reported as `stopReason: 'unstable'`, never hashed.
3. **The descriptor did not change while it was read.** `size` and `mtimeMs` are re-read
   after hashing (`snapshot.ts:338` at `cfc1f26`). A writer that appends, truncates, or
   rewrites without restoring `mtimeMs` is detected. **A same-size rewrite that restores
   `mtimeMs` is not detected at `cfc1f26`.** The working tree adds a `ctimeMs` comparison
   before the read and after hashing (`snapshot.ts:388`, `:405-413`, working tree), tested at
   the descriptor level only (`snapshot-race.test.ts:140`, `:175`, uncommitted). That fix is
   **implemented, uncommitted and unreviewed**; no end-to-end two-snapshot test exercises it.
4. **The bytes hashed match the size the budget was checked against.** A short read with an
   unchanged descriptor size would be a digest covering fewer bytes than it claims
   (`snapshot.ts:347`). No test produces a short read with an unchanged descriptor size:
   `snapshot-race.test.ts:89` changes the size, which check 3's `size` comparison catches first.

What this does **not** catch, stated plainly because an earlier version of this document said
otherwise: at `cfc1f26`, **a same-size, in-place rewrite that also restores `mtimeMs`**. The
inode does not change, the size does not change, and the timestamp is under the writer's
control (`utimes`). One pass cannot distinguish that from a quiet file. The old document said
the size check was "the observable signal that the entry was not stable"; it is a signal for a
size *change*, and that is all it ever was. The old document also claimed a rewrite could not
make a changed file look unchanged *relative to the baseline*. That was measured false: on a
1 GiB file, rewriting the first 4 KiB with `mtime` restored at nanosecond precision produced a
final digest **identical** to the baseline, `changeCount: 0`,
`authoritative: true` — with the file changed (`FINAL-INDEPENDENT-REVIEW.md:2353-2362`). See
limitation 7.

A directory that disappears after being queued (`ENOENT`) stops the walk with
`stopReason: 'unreadable'`, because the tree it was describing is no longer the tree that
exists. That is the code path (`snapshot.ts:716-723`); **no test deletes a queued directory**.
A directory that was queued as a directory and is a symlink by the time it is enumerated stops
the walk with `stopReason: 'unstable'` for the same reason: it is not the tree that was
classified. A directory that is replaced *after* it was enumerated is caught by the parent
identity re-check instead, and stops the walk with `'parent-replaced'`: `listDirectory` would
have seen the swap before reading, the re-check sees it after the children were resolved through
it (F-G20, and §"What never descend through a link covers, exactly").

## What "never descend through a link" covers, exactly

`isContained()` is a lexical check on path strings, and a path string built from a symlinked
parent passes it every time. Containment is therefore the *second* line, not the first. The
first is that no enumeration ever happens through a link:

* the walk only queues a path after `lstat` reports a real directory, and `listDirectory()`
  re-`lstat`s immediately before `readdir`;
* `.git/hooks` — the field that made this concrete, because `readdir` on a symlinked hooks
  directory returned `/etc` and every name in it read as a path inside the root — goes
  through the same helper. A symlinked hooks directory is recorded as
  `hooksDirectoryLinkTarget` and produces zero hook entries;
* `.git` itself, and `.git/HEAD`, are read with `O_NOFOLLOW`: a link is a link, and the
  honest answer for "HEAD is a link" is `null`.

A **parent** directory swapped for a link between the `readdir` that produced a name and the
`lstat`/`open` that hashes it is **detected after the fact, and not prevented** — F-G20. Each
queued directory carries the `lstat` that classified it; after its children are read, the path is
`lstat`ed again and `dev`/`ino`/`ctimeMs` are compared (`directoryIdentityVerdict`,
`snapshot.ts:849`). A parent replaced by a link resolves to a different inode, so the walk stops
with `stopReason: 'parent-replaced'` (`'unstable'` when only `ctime` moved), the subtree's
entries are **withdrawn** — a digest read through the substituted parent may be a digest of a
file outside the workspace, and keeping it would leave an off-tree hash where a reviewer looks
for evidence of the tree — and the snapshot is `complete: false`, which `executeAgentActivity`
turns into a failed attempt with `EVIDENCE_INCOMPLETE` (F-G13). `snapshot-race.test.ts` holds
the window open with the walk's `afterDirectoryListed` seam and asserts all three facts, with a
no-swap negative control that must stay `complete: true`.

The residual is the word *after*. Node exposes no `openat`, so every open here is path-based:
bytes can still be hashed from a momentarily substituted path before the re-check runs, and the
window is bounded by one directory's children. What the attacker keeps is not a clean
manifest — they cannot survive the re-check — but an off-tree read reflected in a file that is
classified incomplete. Closing rather than detecting needs a descriptor-relative walk:
`open(O_DIRECTORY | O_NOFOLLOW)` followed by `readdir`/`fstatat` on the descriptor, or
`openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`. **Not implemented**, and no native code
is added for it. See limitation 9.

## Bounds, and the failure direction

`maxEntries` and a byte ceiling. On exceed the snapshot is marked `complete: false` with a
`stopReason` (`'max-entries'`, `'max-total-bytes'`, `'unreadable'`, `'unstable'`,
`'initial-incomplete'`, `'final-incomplete'`, and `'parent-replaced'` in the working tree).
The `stopReason` values are asserted at `snapshot.test.ts:279` (`max-entries`), `:306`
(`max-total-bytes`) and `:319` (a bounded digest differs from the unbounded one).

An incomplete snapshot is **not** authority, and the chain enforces it end to end:

```
snapshot.complete: false
  → manifest.complete: false
  → evidence.authoritative: manifest.complete           (evidence.ts:426 at cfc1f26)
  → Artifact.authoritative = evidence.authoritative && workspaceId !== null   (persist-result.ts:365)
```

Each arrow is covered by a test: `evidence-provenance.test.ts:667` (bound workspace, incomplete
walk ⇒ `Artifact.authoritative === false`) and `:437` (an authoritative envelope over an
incomplete body is refused). The artifact is still written; it is written **not authoritative**,
which is the correct failure direction — a partial answer labelled partial is useful, and a
partial answer labelled complete is the bug this gate exists to remove.

At `cfc1f26`, an *incomplete* final manifest still yielded a `succeeded` task with no failure
event (F-G13). The working tree returns an `EvidenceCaptureFailure` for it (uncommitted,
`REMEDIATION-REGISTER.md` F-G13) — implemented, not proven here.

## Canonical form and digest

sha256 (`createHash('sha256')`), over a canonical serialisation with a stable field order
and byte-sorted entries. `manifest.ts:307` computes the digest from `serialiseManifest`, so
the digest is reproducible from the stored body — and a test asserts that recomputation
matches and that any edit changes the digest (`change-manifest.test.ts:347-348`).

## Change manifest

Derived from `(initial, final)` only. Per path: `added` / `modified` / `deleted` /
`mode_changed`, with before/after sha256, size and kind. One row per path; `modified` wins
over `mode_changed` for the same path while the mode stays visible in both halves. A file
that became a symlink is a modification with two kinds. Two different roots are refused
rather than compared.

## Exclusions

There is **no** general exclusion mechanism (no `EXCLUD*` in the module) and no agent-supplied
exclusion pattern. The only path-level skip is the **workspace root's** `.git`, excluded as
content and captured as metadata; `.`/`..`/names containing a separator are rejected
defensively. `maxEntries`/`maxTotalBytes` can also stop the walk, which is always reported as
`complete: false`. There is no `.gitignore` consultation, so an agent cannot hide a meaningful
source change by inventing an ignore rule.

At `cfc1f26` the `.git` skip applied at **every** depth while only the root's `.git` was
described. A nested `sub/.git` was therefore described nowhere, and a write inside it produced
`changeCount: 0`, `complete: true`, `authoritative: true` and a digest identical to baseline
(F-G11, `FINAL-INDEPENDENT-REVIEW.md:2530-2558`). The working tree makes the skip root-only and
walks a nested `.git` as content (`snapshot.ts:844`, working tree), with a test
(`snapshot-nested-git.test.ts`, untracked). **Implemented, uncommitted, awaiting independent
review** — not proven here.

## Limitations, stated exactly

1. **Endpoints, not history.** A file changed and reverted within the run is invisible. The
   manifest describes two instants.
2. **Content pre-image is not retained.** The manifest proves *which bytes* changed (hashes);
   it does not reconstruct the old contents. A display patch cannot be derived from it alone.
3. **Hard links.** Two paths to one inode are hashed twice; the manifest describes paths, not
   inodes. A change through one path would appear at both. This is reasoned from the code —
   **no test creates a hard link and asserts the double description**
   (`ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md`, honest gap 2).
4. **Mount crossings.** A mountpoint inside the workspace is walked as directories and files,
   in line with the lexical policy. There is no mount-exclusion policy.
5. **Rename detection is not attempted.** Deletion plus addition is reported. Calling that a
   rename would be an inference, and an inference is not evidence.
6. **A name that is not valid UTF-8 stops the walk.** `readdir` returns a lossy string; the
   `lstat` on the joined string then fails with `ENOENT`, the walk stops with
   `stopReason: 'unreadable'`, and the entry is **absent** from the snapshot
   (`snapshot.ts:753-756`, `:810` at `cfc1f26`; `snapshot.ts:866-869` in the working tree).
   It is not "represented lossily" — it is not represented at all, `complete: false`, and
   because a workspace is reused, **every later snapshot of that workspace is incomplete until
   the name is removed** (`FINAL-INDEPENDENT-REVIEW.md:2614-2623`). Fail-closed, but
   persistent: one `writeFile` with such a name degrades the manifest of every later attempt
   in that workspace. **Trigger to close:** carry names as bytes (`readdir` with
   `encoding: 'buffer'`) and hash the raw byte sequence; until then the correct description is
   "stops", not "degrades".
7. **A same-size rewrite is caught only while it overlaps the read.** At `cfc1f26` the
   after-check compares `size` and `mtimeMs` only, so a same-size in-place rewrite with
   `mtime` restored is accepted, and the result can be a digest **equal to the baseline** with
   the file changed (measured: `FINAL-INDEPENDENT-REVIEW.md:2353-2362`). The working tree adds
   a `ctimeMs` comparison before and after the read (`snapshot.ts:388`, `:405-413`) and the
   descriptor-level tests refuse the rewrite (`snapshot-race.test.ts:140`, `:175`) —
   **uncommitted, unreviewed, and with no end-to-end two-snapshot test**. A rewrite that
   completes before the `lstat` is simply the file's current content and is described as such.
   A write that lands after the final snapshot but before persistence is not covered by
   anything (honest gap 3 of the adversarial suite). **Trigger to close:** commit the `ctime`
   comparison, then add the two-snapshot test the audit asks for; until then this document
   does not claim the bound.
8. **This is not isolation.** A hash establishes content identity, not authenticity. There is
   no signing key and no signature, and the same-UID worker compromise remains open.
9. **A parent directory swapped for a link is detected after the read, not prevented — F-G20.**
   If an attacker can replace a directory with a symlink between its `readdir` and a child's
   `lstat`, the child's `lstat` resolves through the link and the `fstat` agrees by construction
   — `O_NOFOLLOW` covers the final component only. Measured at `cfc1f26`: a **complete,
   authoritative** snapshot carrying `/etc/passwd`, `/etc/group` and `/etc/hostname` digests
   (`FINAL-INDEPENDENT-REVIEW.md:2384-2402`). **What the attacker gains:** an off-tree read
   oracle reflected in the digest — the manifest states the SHA-256 of host files at paths the
   attacker names, and an attacker who can see manifests or digests can test candidate contents
   against them. The window requires a live writer during capture, which Gate G excludes by
   assumption, not by code. **What the working tree changes:** the directory's `dev`/`ino`/
   `ctimeMs` are re-read after its children (`directoryIdentityVerdict`, `snapshot.ts:849`); a
   mismatch stops the walk with `parent-replaced`/`unstable`, **withdraws the contested
   subtree**, and makes the snapshot incomplete, which fails the attempt (`EVIDENCE_INCOMPLETE`).
   `snapshot-race.test.ts` proves it — a swap through the `afterDirectoryListed` seam gives
   `complete: false` and no off-tree digest, and the same tree without the swap is
   `complete: true`. It is **uncommitted and unreviewed**, and it is a **detection**:
   the open is still path-based, so a digest can be computed from a momentarily substituted path
   inside the window. **Trigger to close:** a native helper that walks relative to a directory
   descriptor — `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`, or
   `open(O_DIRECTORY | O_NOFOLLOW)` plus `readdir`/`fstatat` on the descriptor. **Not
   implemented**; the Node `fs` API cannot express either.

## Evidence paths

- `packages/workspace-manager/src/snapshot.ts` (schemas, traversal, `.git` metadata, bounds)
- `packages/workspace-manager/src/manifest.ts` (canonical form, digest, change derivation)
- `apps/worker/src/activities/evidence.ts` (capture, final-evidence outcome, `verifyManifestFile`)
- `apps/worker/src/activities/execute-agent.ts:701,844,1149` (capture points)
- `apps/worker/src/activities/persist-result.ts:365` (authority persistence; workspace binding at `:513`)
- `packages/database/prisma/migrations/20261115180000_phase6_host_evidence_authority/`

## Corrections applied under D-602

Each row is old wording → what this document now says. Verdicts are from
`DOC-CLAIM-AUDIT.md`; no `proven` sentence was weakened.

| Location | Was | Verdict | Now |
|---|---|---|---|
| `:41` (table) | "`.git` excluded at any depth — skipped in the walk, recorded as metadata instead" | **false** | root-only exclusion; nested `.git` is content. Working tree, uncommitted, one untracked test — *implemented, awaiting review*, not proven |
| `:104-108` | "The identity check makes the swap *detected* whenever the target is a different inode" | **false** | not detected at `cfc1f26`; measured complete authoritative snapshot carrying host hashes. Named limitation 9 with the `openat2`/descriptor-walk trigger |
| `:67-68` | "`size` and `mtimeMs` are re-read … a writer that appended or rewrote during the read is detected" | **overstated** | a size change or an `mtime`-moving rewrite is detected; a same-size rewrite with `mtime` restored is not at `cfc1f26`. The `ctimeMs` comparison exists in the working tree, uncommitted |
| `:169-173` | "It **cannot** make a changed file look unchanged against a *baseline*" | **false** | measured false. Limitation 7 now states the bound was false at `cfc1f26` and that the fix is uncommitted with no end-to-end test |
| `:165-167` | non-UTF-8 names "represented lossily rather than rejected" | **false** | the walk stops (`unreadable`), the entry is absent, and every later manifest of that workspace is incomplete |
| `:148-149` | "The only skip is `.git`" | **false** | the root's `.git` only; `maxEntries`/`maxTotalBytes` also stop the walk, reported as incomplete |
| `:38` | `SNAPSHOT_PATH_ESCAPE` implied exercised | **unproven** | no test reaches the throw; the check is lexical and a symlinked parent passes it |
| `:44` | "a bounded walk stops in the same place on every host" | **unproven** | order is deterministic by construction; no test asserts the cut point |
| `:69-70` | short-read check implied exercised | **unproven** | code path; no test produces a short read with an unchanged descriptor size |
| `:159-160` | hard-link double description | **unproven** | reasoned from the code; no test creates a hard link |
| `:3-4` | "40 focused tests passing … independent review outstanding" | drift | the review exists and returns FAIL; counts live in `TEST-RESULTS.md` |
