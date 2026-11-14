# Phase 4 — Workspace Recovery

**Branch:** `phase-4/execution-trust` · **Date:** 2026-11-14
**Subject:** what happens to a workspace when the worker that owned it dies.

**Verdict: VERIFIED.** Leases exist, the reaper acts only on proof, every "do nothing" case is a
tested outcome, and the removal path re-derives the path it deletes instead of trusting the row.

---

## 1. Why Phase 3 had no reaper

Not effort. Without a lease there was no way to distinguish **"a live run"** from **"a directory
left behind by a dead worker"**, and the only safe default was to reap nothing. A reaper that
guesses deletes a user's work.

Phase 4 adds the missing fact: the row records who owns the directory, until when, and when it was
last heard from. Now the reaper has evidence, and every decision it makes can name the evidence.

---

## 2. The lease

`ExecutionWorkspace` gained four columns:

| Column | Meaning |
|---|---|
| `leaseExpiresAt` | when the current owner's claim lapses |
| `leaseOwner` | opaque worker identity (`host:pid:bootId`); deliberately not a foreign key — workers are processes, not rows |
| `lastHeartbeatAt` | last liveness signal; a stale heartbeat with an unexpired lease is **suspect and logged**, not reaped |
| `cleanupAttempts` | how many times reclamation has been tried |

Acquisition is a conditional `UPDATE`:

```sql
... WHERE "leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now()
```

So two workers can never both believe they hold the same directory. The database is the arbiter,
not a convention.

`ExecutionWorkspace.state` is the lifecycle: `requested → provisioning → ready → executing →
cleanup_pending → cleaned`, with `failed`, `quarantined` and `cleanup_failed` as the honest
side-exits. The reaper scans `state NOT IN (terminal) AND leaseExpiresAt < now() - 2×interval`.

**Status: VERIFIED** — `packages/database/prisma/schema.prisma`; `workspace-lifecycle.test.ts`.

---

## 3. Reaper decision table

Order matters. Each row is evaluated before the next.

| # | Condition | Outcome | Why |
|---:|---|---|---|
| 1 | Temporal says the workflow is `RUNNING` or `CONTINUED_AS_NEW` | `skipped_live` — lease extended by 2× interval, heartbeat refreshed | The lease is stale but the work is not. A paused worker resumes; if it does not, the next pass sees the same evidence |
| 2 | Temporal did not answer | `skipped_unknown` | An unreachable server is not evidence that the workflow is gone. "Refusing to reap on doubt" |
| 3 | Lease is inside the grace window | `skipped_fresh` | A clock step or a long GC pause is not abandonment |
| 4 | State already terminal and `cleanedAt` set | `already_clean` | Nothing to do; idempotent |
| 5 | Running attempt row found | attempt → `failed`, `terminationReason='crashed'`, `cleanupState='pending'` | The record says what happened to the process |
| 6 | Attempt cgroup has processes | `cgroup.kill`, `killedPids` recorded | Kill only what is demonstrably this attempt's |
| 7 | Artifacts copy succeeds | copy into the artifact store, then reclaim | Evidence survives the directory |
| 8 | Artifacts copy fails | `quarantined` | Losing the copy must not lose the bytes |
| 9 | Reclaim refuses (containment unproven) | `quarantined` | A path the reaper cannot prove it owns is never deleted |
| 10 | Reclaim fails transiently (`EBUSY`/`ENOTEMPTY`) | `cleanup_pending`, attempts + 1 | Retry |
| 11 | Three failed reclaims | `cleanup_failed` | Give up loudly; a human decides |
| 12 | All checks pass | `reaped` — bytes gone, row `cleaned` | |

**Nothing is reaped on age alone.** `expiresAt` is never consulted. Only the lease and the
workflow's liveness are.

**Nothing is matched by process name.** The only processes killed are the pids listed in that
attempt's `cgroup.procs`, via `cgroup.kill`. A `pkill opencode` would kill a concurrent run, an
editor, or the reaper itself.

**Status: VERIFIED** — `apps/worker/src/reaper.ts`; `reaper.test.ts`.

---

## 4. Reclaim: validate, then delete

`reclaimWorkspace()` is deliberately **not** part of `WorkspaceManager` (which holds in-memory
handles for workspaces it provisioned; a reaper acts on rows whose process is dead — there is no
handle).

| Step | Rule |
|---|---|
| 1 | Ids are re-validated as single path segments (`safeSegment`). `../..` cannot be a task id. |
| 2 | The path is **recomputed from the ids**. The row's `rootPath` is a claim, checked for agreement — never the thing deleted. |
| 3 | Every component between the root and the workspace is `lstat`ed; any symbolic link refuses the reclaim. |
| 4 | The resolved path must equal the resolved expected path and be inside the root. |
| 5 | Only then is anything removed; `artifacts/` is copied first and kept. |

**Why `lstat` and not just `realpath`.** If `root/org-1` is a symlink to `/etc`, `realpath` gives
`/etc/task/ws` and containment fails — good. But if the link points **inside** the root
(`root/org-1 → root/other-org`), containment passes while the reaper deletes another tenant's
workspace. Walking with `lstat` and rejecting links closes both. A legitimate workspace never has a
symlinked component, because `provision()` creates real directories.

---

## 5. Quarantine

Quarantine is the correct outcome when containment cannot be proven. It is not an error state; it
is a held state that requires a human.

| Trigger | Row state | `cleanupError.code` |
|---|---|---|
| Id not a single path segment | `quarantined` | `CONTAINMENT_UNPROVEN` |
| Symlinked ancestor | `quarantined` | `CONTAINMENT_UNPROVEN` |
| `rootPath` disagrees with derived path | `quarantined` | `CONTAINMENT_UNPROVEN` |
| Artifact preservation failed | `quarantined` | preservation failure message |
| Transient `rm` failure, attempts < 3 | `cleanup_pending` | `RECLAIM_FAILED` |
| Transient `rm` failure, attempts ≥ 3 | `cleanup_failed` | `RECLAIM_FAILED` |

A quarantined row is never retried automatically. Its bytes stay on disk and the reason stays in
the row. That is the intended cost: a stranded directory is cheaper than a deleted tenant.

---

## 6. The 13 crash tests

`apps/worker/test/reaper.test.ts`. Each positive case has a negative control beside it; the
"do nothing" cases are the reason the "delete" cases are acceptable.

| # | Test | Proves |
|---:|---|---|
| 1 | "reaps an abandoned attempt: attempt failed/crashed, workspace cleaned, bytes gone" | the happy path, end to end |
| 2 | "reclaims a workspace a crashed worker already queued as cleanup_pending" | recovery of a half-finished pass |
| 3 | "leaves a workspace alone while its workflow is still running" | `skipped_live` + lease extension |
| 4 | "leaves a workspace alone when its lease is still current" | `skipped_fresh` |
| 5 | "refuses to reap when Temporal does not answer" | `skipped_unknown` |
| 6 | "never touches a sibling workspace under another orgId" | tenant scoping on the filesystem |
| 7 | "quarantines a workspace id that is not a single path segment" | `../..` in a database value |
| 8 | "refuses a workspace reached through a symlinked ancestor" | the symlink-inside-root case |
| 9 | "refuses a row whose rootPath disagrees with the path its ids derive" | the row is a claim, not a target |
| 10 | "is idempotent: a second pass changes nothing, and a crash after queueing resumes cleanly" | no double-delete, no lost state |
| 11 | "gives up after three failed removals and records why" | `cleanup_failed` at attempt 3 |
| 12 | "copies artifacts/ into the artifact store before removing the workspace" | evidence survives |
| 13 | "keeps artifacts in place and quarantines when the copy fails" | bytes are never lost to a failed copy |

**Status: VERIFIED** — 13 passed against a real Postgres and disposable temp roots. Every path
assertion is inside a `mkdtemp` directory; the reaper's `workspaceRoot` is that directory, so a
test cannot reach outside it.

---

## 7. What the reaper deliberately does not do

| Not done | Reason |
|---|---|
| Delete on `expiresAt` alone | Retention is a policy deadline, not evidence of abandonment |
| `pkill` by name | Would kill concurrent runs, editors, or the reaper |
| Retry a quarantined row | A human must look; automatic retry would eventually delete the thing quarantine protected |
| Reclaim a path it cannot re-derive | The row may be wrong; the ids are re-validated and the path recomputed |
| Emit an audit event for every pass | The action is recorded on the workspace row and the attempt; a per-pass event stream would be noise |
| Sweep orphaned directories with no row | Out of scope. A directory with no row is invisible to this reaper — see §8 |

---

## 8. Residuals

1. **A directory with no row is not reclaimed.** The reaper is row-driven. If a row is deleted while
   the directory exists, the bytes stay until an operator looks. `onDelete: Cascade` on the task
   relation removes the row when a task is deleted — the directory is then orphaned by definition.
2. **Temporal liveness is the only proof of "not running".** If the workflow is `COMPLETED` but the
   worker is still writing (a race), the reaper could act while a process is alive. The lease grace
   (2× interval) makes this unlikely; `cgroup.kill` makes it safe if it happens.
3. **Clock skew between workers.** Lease expiry is database time in the query (`lt: cutoff` computed
   in the worker). A worker with a fast clock reaps early; the grace window absorbs seconds, not
   minutes.
4. **`killedPids` is a count read before the kill, not a confirmation of death.** `cgroup.kill` is
   atomic and the full-tier test proves zero processes remain, but the row records what was listed,
   not what was reaped.
5. **Cleanup is not transactional with the filesystem.** A crash between artifact copy and `rm`
   leaves a `cleanup_pending` row, which test 10 covers as a resumable state — not as a guarantee
   that the copy is not repeated.
6. **Quarantined rows accumulate.** There is no UI or CLI to list them beyond a query. They are
   visible in `state = 'quarantined'` and in `cleanupError`, which is the minimum an operator needs
   and not a workflow.
