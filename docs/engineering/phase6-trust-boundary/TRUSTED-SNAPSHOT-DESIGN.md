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
control surface change", and it never substitutes for observing the tree.

## Traversal

| Property | Implementation | Line |
|---|---|---|
| `lstat` only, never `stat` | symlinks classified, not followed | `snapshot.ts:239` |
| Symlink target recorded as a string | `readlink`, hashed as `symlink:<target>` | `:320` |
| Lexical containment | `isContained()` on every directory **and** every entry; throws `SNAPSHOT_PATH_ESCAPE` | `:462`, `:495` |
| `realpath` deliberately **not** used | would follow exactly the symlinks the module refuses to | `:426` |
| `.git` excluded at any depth | skipped in the walk, recorded as metadata instead | `:481` |
| Deterministic order | `Buffer.compare` on path bytes, not `Array.sort` (UTF-16 would mis-order astral characters) | `:187-193` |
| Deterministic truncation | sorted frontier, breadth-first, so a bounded walk stops in the same place on every host | `:442-454` |
| Root must be a real directory | rejects symlinked or non-directory root | `:666` |

## Entry model

`file` · `dir` · `symlink` — with `mode & 0o7777`, size, sha256 (regular files only), and
`symlinkTarget`. Directories carry `sizeBytes: 0, sha256: null` and are queued.

Breadth-first keeps the stack proportional to directory count rather than tree depth, and
means a truncated snapshot still includes every top-level entry — the more useful half of a
partial answer.

## Consistency during capture

A file can change between `lstat` and `readFile`. The implementation hashes the bytes it
actually read and compares against the size `lstat` reported; a mismatch is the observable
signal that the entry was not stable, which is why the size is carried alongside the digest
rather than being decorative (`:205`).

A directory that disappears after being queued (`ENOENT`) is not ignored — the walk stops
with `stopReason: 'unreadable'`, because the tree it was describing is no longer the tree
that exists.

## Bounds, and the failure direction

`maxEntries` and a byte ceiling. On exceed the snapshot is marked `complete: false` with a
`stopReason` (`'max-entries'`, `'unreadable'`, `'initial-incomplete'`, `'final-incomplete'`).

An incomplete snapshot is **not** authority, and the chain enforces it end to end:

```
snapshot.complete: false
  → manifest.complete: false
  → evidence.authoritative: manifest.complete           (evidence.ts:242)
  → Artifact.authoritative = evidence.authoritative && workspaceId !== null   (persist-result.ts:354)
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
7. **This is not isolation.** A hash establishes content identity, not authenticity. There is
   no signing key and no signature, and the same-UID worker compromise remains open.

## Evidence paths

- `packages/workspace-manager/src/snapshot.ts` (schemas, traversal, `.git` metadata, bounds)
- `packages/workspace-manager/src/manifest.ts` (canonical form, digest, change derivation)
- `apps/worker/src/activities/evidence.ts` (capture + `manifestsEqual`/`verifyManifestFile`)
- `apps/worker/src/activities/execute-agent.ts:613,756,1007` (capture points)
- `apps/worker/src/activities/persist-result.ts:270-380` (authority persistence)
- `packages/database/prisma/migrations/20261115180000_phase6_host_evidence_authority/`
