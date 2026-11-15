# Phase 6 — evidence index

**Measured at:** `cfc1f26`; uncommitted working-tree corrections are marked *uncommitted*.
**Parent:** `58476b0`
**Branch:** `phase-6/trust-boundary-closure`
**Push status:** NOT PUSHED — no remote is configured.

Every claim in this phase's reports should be traceable to one of the paths below. If a claim
is not traceable, it is not evidence.

**Corrected under D-602.** The authority row below cited tests that do not assert authority,
and the index listed an `EXECUTIVE-REPORT.md` that was never written into this directory. Both
are fixed; the old wording is named where it changed.

## Reports

| # | Report | Covers |
|---|---|---|
| 1 | `PHASE5-COMMIT-AUDIT.md` | 53 paths, linear ancestry, one misplaced file relocated |
| 2 | `ISOLATION-TEST-STABILITY.md` | Flake root cause (14.77% designed bucket), hypothesis rejected |
| 3 | `APPROVAL-TOCTOU-ROOT-CAUSE.md` | Four layers of the authorization defect |
| 4 | `APPROVAL-ATOMIC-CLAIM-VERIFICATION.md` | The claim, its identity, its review history |
| 5 | `ARTIFACT-INTEGRITY-ROOT-CAUSE.md` | Three measured git attacks against the pre-fix pipeline |
| 6 | `TRUSTED-SNAPSHOT-DESIGN.md` | Traversal, canonical form, bounds, limitations |
| 7 | `ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md` | Attacks, positive control, honest gaps |
| 8 | `CREDENTIAL-CUSTODY-ASSESSMENT.md` | Same-UID store, in-process broker, Phase 7 shape |
| 9 | `TEST-RESULTS.md` | Exact commands, exit codes, counts, skips |
| 10 | `PHASE6-GATE-MATRIX.md` | Gates A–R, G-01…G-21 |
| 11 | `REMEDIATION-REGISTER.md` | O1–O11, F1–F4, N1–N15, G-A…G-G, F-G1…F-G20, D-01…D-07 |
| 12 | `FINAL-INDEPENDENT-REVIEW.md` | Four review rounds + Gate G review |
| 13 | `EVIDENCE-INDEX.md` | This file |
| 14 | `DOC-CLAIM-AUDIT.md` | 64 claim verdicts, correction list |
| 15 | `PHASE7-SCOPING.md` | The credential-custody workstream A hands to Phase 7 |

The index previously listed an `EXECUTIVE-REPORT.md` as report 14. No such file exists in this
directory and none is referenced from a commit; the row is removed rather than left as a
promise. `HARNESS-HYGIENE.md` is a process record and is not part of the evidence chain.

Supporting records written during the work:
`AG-603-IDENTITY-AND-AUTHORITY.md`, `AG-604-CLAIM-IDENTITY-AND-WRITE-AUTHORITY.md`,
`TRUST-BOUNDARY-CLOSURE.md`, `docs/engineering/phase5-recovery/API-CONTRACT-DELTA.md`.

## Code — authorization

| Path | Why |
|---|---|
| `apps/worker/src/activities/claim.ts` | Conditional `updateMany`, `executionIdentity()`, completion/event/start authority |
| `apps/worker/src/activities/execute-agent.ts` | Launch-site gate order; evidence capture points `:701`, `:844`, `:1149` at `cfc1f26` (`:786`, `:936`, `:1254` in the working tree) |
| `apps/worker/src/activities/attempts.ts` | Adoption CAS includes claim ownership |
| `apps/worker/src/approvals/authorisation.ts` | Shared approval/risk logic for validation **and** launch |
| `apps/worker/src/claim-release.ts` | Reaper-only release on the recorded pair |
| `apps/worker/src/reaper.ts` | Liveness probe and `classifyProbeError` |
| `apps/worker/src/activities/{validate-task,persist-result,complete-task,emit-event,record-start}.ts` | Gate at each mutating activity |

## Code — evidence

| Path | Why |
|---|---|
| `packages/workspace-manager/src/snapshot.ts` | `lstat`/`readlink` walk, containment, `.git` metadata, bounds |
| `packages/workspace-manager/src/manifest.ts` | Canonical form, digest, change derivation |
| `apps/worker/src/activities/evidence.ts` | `captureInitialEvidence`, `captureFinalEvidence`, `verifyManifestFile` |
| `apps/worker/src/shared/evidence.ts` | Shared evidence contract (workflow-bundle safe) |
| `apps/worker/src/activities/artifacts.ts` | Materialisation, re-hash, output budget |

## Schema and migration

| Path | Why |
|---|---|
| `packages/database/prisma/schema.prisma` | 15 models; Gate G columns on `Artifact` and `ExecutionWorkspace` |
| `.../migrations/20261115060000_phase6_execution_claim/` | `claimedByWorkflowRunId`, `claimedAt` |
| `.../migrations/20261115120000_phase6_claim_workflow_id/` | `claimedByWorkflowId` |
| `.../migrations/20261115180000_phase6_host_evidence_authority/` | 8 additive columns, no back-fill |

## Tests that would fail if a control were removed

| Property | Test |
|---|---|
| One winner under concurrency | `execution-claim.test.ts` |
| Standalone activity cannot forge identity | `execution-identity.test.ts` |
| Launch site refuses an unapproved HIGH task | `execution-boundary.test.ts` |
| Live claim never released | `execution-boundary.test.ts` §N2/N7 |
| Legacy claim cannot starve the pass | `execution-boundary.test.ts` N12 |
| Workflow-id writer is exercised | `execution-boundary.test.ts:868` N13 |
| Staging cannot shape authority | `change-manifest.test.ts:57` |
| Clean filter cannot shape authority | `change-manifest.test.ts:106` |
| Commit cannot shape authority | `change-manifest.test.ts:161` |
| Hostile helpers never execute | `hostile-repository.test.ts:133` + positive control `:243` |
| Adapter cannot choose the workspace | `evidence-provenance.test.ts:432,477` |
| Incomplete manifest is not authority | `evidence-provenance.test.ts:667` (bound workspace, incomplete walk ⇒ `authoritative false`) and `:437` (authoritative envelope over an incomplete body refused); `persist-result.ts:365` |
| Same-size rewrite refused — **uncommitted** | `snapshot-race.test.ts:140`, `:175` (descriptor level; no end-to-end two-snapshot test) |
| Nested `.git` is content — **uncommitted** | `snapshot-nested-git.test.ts` (untracked) |

## Commands

```bash
pnpm -w lint
pnpm -w typecheck
pnpm -w test
pnpm --filter @intelligenz/api test:e2e
pnpm -w build
npx vitest run packages/workspace-manager/test/snapshot.test.ts \
  packages/workspace-manager/test/change-manifest.test.ts \
  packages/workspace-manager/test/hostile-repository.test.ts
npx vitest run apps/worker/test/execution-{boundary,claim,identity}.test.ts
```

Fresh-database migration check (throwaway DB, socket auth):

```bash
createdb iz_fresh
DATABASE_URL="postgresql://ubuntu@localhost/iz_fresh?host=/var/run/postgresql" \
  npx prisma migrate deploy
```

## Artifact authority after the bytes are gone — the F-G16 decision

`Artifact.authoritative` is a **historical claim**: "a host process measured these bytes at this
time". It is not a liveness check, and no column can be one — a filesystem can lose a file
between any two statements.

The reaper's demotion guard (`reaper.ts:525-562`, `revokeUnbackedAuthority` at `:643`) runs **at reclaim
time, for the workspace being reclaimed**:

* it is not a periodic sweep, and terminal states (`cleaned`, `quarantined`, `cleanup_failed`)
  are excluded from the candidate query on purpose — a sweep over every authoritative artifact
  row is an unbounded scan, and it would race the artifact cache on every pass;
* therefore **a `cleaned` or `quarantined` row whose bytes disappear out of band keeps
  `authoritative: true`**. That is the decision, not a gap nobody noticed. The row still says
  what happened when the bytes existed;
* what makes that honest is the **read path**, which recomputes from the bytes on every request
  and never serves a stored claim:
  * the download returns `410 ARTIFACT_GONE` when the file is absent
    (`artifacts.service.ts:107-113`),
  * the summary reports `integrity: 'unknown'` beside `authoritative` when the bytes cannot be
    read (`artifact-summary.ts:46-62`), so a UI cannot render "authoritative" without the
    measurement that would back it.

**Trigger to revisit:** if an operator needs "no authoritative row points at unreadable bytes" as
an *invariant* rather than a read-time property, the work is a batched repair sweep over
`Artifact.authoritative = true` scoped by org and paged by id, writing the same
`artifact.authority_revoked.v1` event the reclaim path writes. Until then this document states
the scope, explicitly: **authority is demoted at reclaim time**; afterwards, the read path
refuses.

## Rescue checkpoint

Before any Gate G change, the 35-file dirty tree was preserved outside the repository:

```
/tmp/opencode/gate-g-rescue-20261115T140145Z/
  status.txt  tracked-working-tree.patch  staged.patch  untracked-files.tar.gz  SHA256SUMS
```

Temporary: it is a recovery aid for this session, not a durable artefact. The durable record
is the commit history.
