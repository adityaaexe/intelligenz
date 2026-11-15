# Trusted snapshot design

**Gate:** G · **Component:** `packages/workspace-manager/src/snapshot.ts`, `manifest.ts`
**Status at time of writing:** implemented, 40 focused tests passing, full suite 875/15 skipped, **independent review outstanding**

## The one-sentence design

The host walks the workspace filesystem with `lstat` and `readlink` and nothing else,
hashes what it finds into one canonical body, and compares two such bodies into a change
manifest — so the description of what changed is produced by the process that observed the
filesystem, not by a program the repository can configure.

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
control surface change", and it never substitutes for observing the tree. A `.git/hooks`
that is a symbolic link is recorded by its target (`hooksDirectoryLinkTarget`) and
contributes **no** hook entries: a link is a fact about the repository's control surface,
and listing what it points at would make that field a read primitive for the host
filesystem.

## Traversal

| Property | Implementation | Line |
|---|---|---|
| `lstat` only, never `stat` | symlinks classified, not followed | `snapshot.ts:361` |
| Symlink target recorded as a string | `readlink`, hashed as `symlink:<target>` | `:391` |
| **Every directory is enumerated through one helper** | `listDirectory()` `lstat`s the path first; a symlink is recorded by target and **never listed**. Used for the content walk and for `.git/hooks`. | `:391` |
| Lexical containment of every path string | `isContained()` on every directory **and** every entry; throws `SNAPSHOT_PATH_ESCAPE` | `:671`, `:713` |
| Contested entries are refused | `open(O_RDONLY \| O_NOFOLLOW)` + `fstat`; `dev`/`ino`/`size` compared with the `lstat` that classified the entry | `:301` |
| `realpath` deliberately **not** used | would follow exactly the symlinks the module refuses to | `:671` |
| `.git` excluded at any depth | skipped in the walk, recorded as metadata instead | `:729` |
| Definite git metadata is not read through links | `config`/`index`/`hooks` follow the same rule; `.git/HEAD` and `.git` itself are read with `O_NOFOLLOW` | `:433`, `:470` |
| Deterministic order | `Buffer.compare` on path bytes, not `Array.sort` (UTF-16 would mis-order astral characters) | `:221` |
| Deterministic truncation | sorted frontier, breadth-first, so a bounded walk stops in the same place on every host | `:690` |
| Root must be a real directory | rejects symlinked or non-directory root | `:912` |

## Entry model

`file` · `dir` · `symlink` — with `mode & 0o7777`, size, sha256 (regular files only), and
`symlinkTarget`. Directories carry `sizeBytes: 0, sha256: null` and are queued.

Breadth-first keeps the stack proportional to directory count rather than tree depth, and
means a truncated snapshot still includes every top-level entry — the more useful half of a
partial answer.

## Consistency during capture

A file can change between `lstat` and the read that hashes it. Four things are checked, and
they are not the same check:

1. **The path is opened without following a link.** `O_NOFOLLOW` makes `open` fail (`ELOOP`)
   if the final component became a symlink after it was classified as a regular file. That
   swap is the `lstat` → `open` race, and it used to be resolved in the attacker's favour.
2. **The descriptor is the inode that was classified.** `fstat` is compared with the
   `lstat` result: different `dev`/`ino` or a different `size` is a contested entry, and a
   contested entry **fails** — it is reported as `stopReason: 'unstable'`, never hashed.
3. **The descriptor did not change while it was read.** `size` and `mtimeMs` are re-read
   after hashing; a writer that appended or rewrote during the read is detected.
4. **The bytes hashed match the size the budget was checked against.** A short read with an
   unchanged descriptor size would be a digest covering fewer bytes than it claims.

What this does **not** catch, stated plainly because an earlier version of this document
implied otherwise: **a same-size, in-place rewrite that also preserves `mtimeMs`.** The
inode does not change, the size does not change, and the timestamp is under the writer's
control (`utimes`). One pass cannot distinguish that from a quiet file, and a second pass
narrows the window without closing it. The old document said the size check was "the
observable signal that the entry was not stable"; it is a signal for a size *change*, and
that is all it ever was. The consequence is bounded: the recorded digest is of a byte
sequence that may not have existed at any single instant, and a later snapshot of the same
path will report a different digest, so a rewrite cannot make a changed file look unchanged
*relative to the baseline*.

A directory that disappears after being queued (`ENOENT`) is not ignored — the walk stops
with `stopReason: 'unreadable'`, because the tree it was describing is no longer the tree
that exists. A directory that was queued as a directory and is a symlink by the time it is
enumerated stops the walk with `stopReason: 'unstable'` for the same reason: it is not the
tree that was classified.

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
`open` that hashes it is still not closed by this: Node exposes no `openat` over a directory
descriptor, so the final path is always resolved from the root. The identity check makes the
swap *detected* whenever the target is a different inode, which is every case except a
same-inode/same-size substitution. The same window exists, one step earlier, between
`listDirectory`'s `lstat` and its `readdir`: a directory that becomes a link in that instant
would be listed through. Closing it needs `open(O_DIRECTORY | O_NOFOLLOW)` followed by a
`readdir` on the descriptor, which the Node `fs` API does not offer.

## Bounds, and the failure direction

`maxEntries` and a byte ceiling. On exceed the snapshot is marked `complete: false` with a
`stopReason` (`'max-entries'`, `'unreadable'`, `'initial-incomplete'`, `'final-incomplete'`).

An incomplete snapshot is **not** authority, and the chain enforces it end to end:

```
snapshot.complete: false
  → manifest.complete: false
  → evidence.authoritative: manifest.complete           (evidence.ts:412)
  → Artifact.authoritative = evidence.authoritative && workspaceId !== null   (persist-result.ts:365)
```

The artifact is still written. It is written as **not authoritative**. That is the correct
failure direction: a partial answer that is labelled partial is useful; a partial answer
labelled complete is the bug this gate exists to remove.

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

There is **no** general exclusion mechanism (no `EXCLUD*` in the module). The only skip is
`.git`, which is excluded as content and captured as metadata. There is no `.gitignore`
consultation and no agent-supplied exclusion pattern — which means an agent cannot hide a
meaningful source change by inventing an ignore rule.

## Limitations, stated exactly

1. **Endpoints, not history.** A file changed and reverted within the run is invisible. The
   manifest describes two instants.
2. **Content pre-image is not retained.** The manifest proves *which bytes* changed (hashes);
   it does not reconstruct the old contents. A display patch cannot be derived from it alone.
3. **Hard links.** Two paths to one inode are hashed twice; the manifest describes paths, not
   inodes. A change through one path appears at both, which is truthful but not minimal.
4. **Mount crossings.** A mountpoint inside the workspace is walked as directories and files,
   in line with the lexical policy. There is no mount-exclusion policy.
5. **Rename detection is not attempted.** Deletion plus addition is reported. Calling that a
   rename would be an inference, and an inference is not evidence.
6. **Path bytes.** Names are carried as JavaScript strings from `readdir`. A name that is not
   valid UTF-8 cannot be represented faithfully by that API; such an entry would be
   represented lossily rather than rejected. Recorded as a known limitation.
7. **A same-size rewrite is not detected.** See "Consistency during capture": if a writer
   changes bytes without changing the inode, the size or `mtimeMs`, one pass records a
   digest of a state that may never have existed at a single instant. It cannot make a
   changed file look unchanged against a *baseline*, and a later snapshot reports a
   different digest, but the `after` fingerprint of that entry is not provably true of any
   instant.
8. **This is not isolation.** A hash establishes content identity, not authenticity. There is
   no signing key and no signature, and the same-UID worker compromise remains open.

## Evidence paths

- `packages/workspace-manager/src/snapshot.ts` (schemas, traversal, `.git` metadata, bounds)
- `packages/workspace-manager/src/manifest.ts` (canonical form, digest, change derivation)
- `apps/worker/src/activities/evidence.ts` (capture, final-evidence outcome, `verifyManifestFile`)
- `apps/worker/src/activities/execute-agent.ts:701,844,1149` (capture points)
- `apps/worker/src/activities/persist-result.ts:365` (authority persistence; workspace binding at `:513`)
- `packages/database/prisma/migrations/20261115180000_phase6_host_evidence_authority/`
