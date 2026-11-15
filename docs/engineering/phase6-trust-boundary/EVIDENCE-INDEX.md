# Phase 6 — evidence index

**Commit:** `9461d2773a2902dee91d0f36a22977356548c01e`
**Parent:** `58476b0`
**Branch:** `phase-6/trust-boundary-closure`
**Push status:** NOT PUSHED — no remote is configured.

Every claim in this phase's reports should be traceable to one of the paths below. If a claim
is not traceable, it is not evidence.

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
| 10 | `PHASE6-GATE-MATRIX.md` | Gates A–R, G-01…G-20 |
| 11 | `REMEDIATION-REGISTER.md` | O1–O11, F1–F4, N1–N15, G-A…G-G |
| 12 | `FINAL-INDEPENDENT-REVIEW.md` | Four review rounds + Gate G review |
| 13 | `EVIDENCE-INDEX.md` | This file |
| 14 | `EXECUTIVE-REPORT.md` | Verdict and remaining risk |

Supporting records written during the work:
`AG-603-IDENTITY-AND-AUTHORITY.md`, `AG-604-CLAIM-IDENTITY-AND-WRITE-AUTHORITY.md`,
`TRUST-BOUNDARY-CLOSURE.md`, `docs/engineering/phase5-recovery/API-CONTRACT-DELTA.md`.

## Code — authorization

| Path | Why |
|---|---|
| `apps/worker/src/activities/claim.ts` | Conditional `updateMany`, `executionIdentity()`, completion/event/start authority |
| `apps/worker/src/activities/execute-agent.ts` | Launch-site gate order; evidence capture points `:613`, `:756`, `:1007` |
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
| Incomplete manifest is not authority | `change-manifest.test.ts:304,330` + `persist-result.ts:354` |

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

## Rescue checkpoint

Before any Gate G change, the 35-file dirty tree was preserved outside the repository:

```
/tmp/opencode/gate-g-rescue-20261115T140145Z/
  status.txt  tracked-working-tree.patch  staged.patch  untracked-files.tar.gz  SHA256SUMS
```

Temporary: it is a recovery aid for this session, not a durable artefact. The durable record
is the commit history.
