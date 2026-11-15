# Phase 6 — remediation register

**Measured at:** `cfc1f26`; the working tree adds uncommitted corrections, marked *uncommitted*
below. A status is not upgraded because code exists that no reviewer has seen.
**Continues:** `docs/engineering/phase5-recovery/REMEDIATION-REGISTER.md` (O1–O11). That file is not rewritten; it is referenced.

**Status vocabulary:** CLOSED · PARTIAL · OPEN · BLOCKED · NOT A DEFECT

## Phase 5 items, resolved this phase

| ID | Item | Status | Resolution |
|---|---|---|---|
| **O1** | Approval→attempt TOCTOU: two executions could both validate while the attempt was `queued` | **CLOSED** | Durable one-shot claim enforced at the launch site (`9461d27` lineage: `3aed33d` → `74207f0` → `a75f121` → `23db912`). Four independent reviews; the last could not reproduce a bypass. |
| **O11** | One flaky isolation test, "volume-pool contention suspected" | **CLOSED — hypothesis was wrong** | Not contention (0 stray locks, volumes at 1%). `LocalSimulatedRuntime` fails `hash(taskId ␀ goal) % 1000 < 150` by design; fixture used a random UUID. Computed 14.77%, observed 1/6. Fixed with the documented `[simulate:ok]` lever; assertion unchanged; 15 consecutive green runs. |
| O2 | Credential store shares the worker's UID | **OPEN** | Confirmed by measurement: store `-rw-------` uid 1000, broker in-process. Dedicated Phase 7 workstream. |

## Findings raised and closed during Phase 6

### Review round 1 — `3aed33d` FAIL

| ID | Finding | Status | Evidence |
|---|---|---|---|
| F1 | Launch site ignored the claim and the approval: an unapproved HIGH task ran when `executeAgentActivity` was invoked directly | **CLOSED** | Entry check at the only path to `runtime.execute`; test asserts typed refusal with zero side effects |
| F2 | Adoption ignored the claim: a non-owner could adopt an attempt claimed by another | **CLOSED** | CAS includes `claimedByWorkflowRunId`; removing only that conjunct makes the intruder adopt |
| F3 | Two direct starts with no attempt id both ran | **CLOSED** | Refused at validation and at the executor; two real Temporal starts → 0 `AgentRun` |
| F4 | Fixing F2 without a release path would wedge attempts | **CLOSED** | Release shipped in the same commit; see I in the gate matrix (liveness arm) |

### Review round 2 — `74207f0` FAIL

| ID | Finding | Status | Evidence |
|---|---|---|---|
| N1 | **High** — identity forgeable via a caller-supplied fallback; a standalone activity ran a duplicate under the victim's claim | **CLOSED** | `executionIdentity()` is zero-argument, context-only; identity fields deleted from inputs; 19 identity tests |
| N2 | `WorkflowNotFoundError` carries no gRPC code, so `absent` was unreachable and a deleted run stranded its claim | **CLOSED** | Classification by error identity; classifier byte-identical to `a75f121`; real-server tests |
| N3 | `drive-run.ts start` passed no attempt id | **CLOSED** | Requires it; refused before connecting, exit 2 |
| N4 | `persistResult` / `completeTask` dispatchable with no claim check | **CLOSED for the two named; class closed for `Task` writes** | Both refuse before their first write; five other aggregate namespaces remain open (N15) |

### Review round 3 — `a75f121` PASS gate / FAIL commit

| ID | Finding | Status | Evidence |
|---|---|---|---|
| N7 | **Regression from N2's fix** — release reaped a live claim when the holder's workflow id was not `task-<taskId>` | **CLOSED** | `claimedByWorkflowId` recorded at claim time; probe asks the recorded pair. Test produces `released` on `a75f121`, `skipped_live` now |
| N8 | Pre-dispatch completion arm accepted `succeeded` for a task with zero attempts | **CLOSED** | Narrowed to `failed`/`cancelled` |
| N4 class | `emitEventActivity` / `recordStartActivity` unauthenticated | **CLOSED for `Task`-aggregate writes only** | Authority before first write, gated on `aggregateType === 'Task'` (`emit-event.ts:73`); `workflow.*`, `agent.*`, `approval.*`, `project.*` and `run.*` remain writable by name (N15). The status cell used to read "CLOSED", which read as the write class |

### Review round 4 — `23db912` PASS

| ID | Finding | Status | Evidence |
|---|---|---|---|
| N12 | Legacy (NULL workflow id) claims filled batch slots and starved a releasable claim | **CLOSED** | Excluded from candidate selection; read-time skip retained as the control |
| N13 | Deleting the writer that records the workflow id left 51/51 green | **CLOSED** | Test takes its claim from the shipped validation path; fails with `expected null to be 'probe-…'` when the writer is removed |
| N14 | Comments still promised `task.failed.v1` as the durable refusal record | **CLOSED** | Corrected to name `execution.claim_duplicate.v1` |
| N15 | "N4 closed" overstated the class | **CLOSED (as a scoping correction)** | Scoped to `Task`-aggregate writes; five namespaces named as open |
| N9/N11 | An unclaimed `running` attempt is foreign to its own execution | **OPEN — fail-closed, documented** | Migration-window only; exact row shape recorded; predicate deliberately not relaxed |

## Findings raised during the Gate G audit

| ID | Finding | Status | Evidence |
|---|---|---|---|
| G-A | `providerMeta.workspaceId` was accepted as a workspace *candidate*, letting an adapter attribute its artifacts to a sibling workspace of the same task | **CLOSED** | `candidate` parameter deleted; derivation from `(workflowRunId, attemptNumber)` scoped by org+task; new tests fail pre-fix (2 failed / 5 passed) |
| G-B | One `consistent-type-imports` lint error in a Gate G test file | **CLOSED** | `pnpm -w lint` exit 0 |
| G-C | Manifest pre-image is not retained, so a display patch cannot be derived from the manifest alone | **NOT A DEFECT — documented limitation** | Recorded in `TRUSTED-SNAPSHOT-DESIGN.md` |
| G-D | No mount-exclusion policy; a mountpoint inside the workspace is walked | **OPEN — documented** | Lexical policy is consistent; no adversarial mount test exists |
| G-E | Non-UTF-8 filenames stop the walk | **OPEN — documented, corrected** | `readdir` returns a lossy string, `lstat` on it fails, the walk stops `unreadable`, the entry is absent, and every later manifest of the reused workspace is incomplete. This row used to say "represented lossily", which was false |
| G-F | No signing: a hash is content identity, not authenticity | **OPEN — by design** | Stated in the design doc and the gate matrix; no key exists |
| G-G | The flow covers three git attacks, not all filesystem attacks (no mount crossing, no hard-link inode test) | **OPEN — documented** | `ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md` §"honest gaps" |

## Findings raised by the Gate G independent review (`9461d27` — **FAIL**)

| ID | Severity | Finding | Status |
|---|---|---|---|
| **F-G1** | **High** | `.git/hooks` as a directory symlink escaped the tree: 98 entries read from `/etc`, including `/etc/passwd`'s SHA-256, reflected in the manifest. `isContained` is lexical; `readdir` followed the symlinked parent. | **CLOSED** — round 2, `snapshot-escape.test.ts:63` |
| **F-G2** | **High** | `chmod 000` on one directory ⇒ `EACCES` ⇒ `captureFinalEvidence` returns `null` ⇒ **task still `succeeded`**, no manifest, no signal. Absence of evidence indistinguishable from "no changes". | **CLOSED** — round 2; attempt and task `failed`, `EVIDENCE_MISSING`, `attempt.evidence_failed.v1` |
| **F-G3** | Medium | The reaper deletes `evidence/` after preserving artifacts; `authoritative:true` rows keep URIs that can never be read (measured). | **CLOSED for the measured path** — the guard is not an invariant; the residual is F-G16 |
| F-G4 | Medium | A 96 MiB same-size in-place rewrite produced `complete: true` with a digest matching neither the original nor the final bytes; the design doc overstates what the size check detects. | **Superseded by round 2 (High)** — see the `cfc1f26` table below |
| F-G5 | Medium | `lstat`→`open` race: no `O_NOFOLLOW` on the read, so a file could be swapped for a symlink between check and read. Reasoned, not reproduced. | **CLOSED for the final component** — `O_NOFOLLOW` + `fstat`, `snapshot-race.test.ts:54`. The **parent** component is a separate, open window (F-G20) |
| F-G6 | Medium | `verifyManifestFile` is self-consistency only — it never parses the body and never binds to `ExecutionWorkspace` digests. | **IN FIX** |
| F-G7 | Low | `.git` metadata changes never appear as a change-manifest row. | Documented |
| F-G8 | Low | Two inaccurate doc claims, including "no `child_process` under `packages/workspace-manager/src`" while `manager.ts:1` imports it. | **IN FIX (doc)** |
| F-G9/F-G10 | Info | Replay binding uses the newest attempt/run rather than the execution in context; no live probe of the process-tree guarantee (it rests on `--unshare-pid` at `sandbox.ts:322`). | Documented |

### Round 2 on `cfc1f26` — F-G1/F-G2/F-G3 closed, three new defects

| ID | Severity | Finding | Status |
|---|---|---|---|
| **F-G11** | **High** | `.git` is excluded at **any depth** but only the root is described. A pre-existing `sub/.git` plus an agent write inside it gives `changeCount: 0`, `complete: true`, `authoritative: true`, **digest identical to baseline**. Deterministic, no race, no forgery. | **IN FIX — working tree, uncommitted, unreviewed** (root-only exclusion; test untracked) |
| **F-G4** | **High** | The documented same-size bound is **false**: a same-size write into an already-read region with `mtime` restored at ns precision gives a digest equal to baseline. `ctime` changes and is not compared. | **IN FIX — working tree, uncommitted**; descriptor-level tests only, no end-to-end two-snapshot test |
| **F-G13** | Medium | One `truncate` to 9 GiB, or a filename the walk refuses, makes the manifest incomplete ⇒ `authoritative: false` ⇒ **task still `succeeded`**, no failure event. Same class as F-G2. | **FIXED — working tree, uncommitted, unreviewed.** Attempt fails with `EVIDENCE_INCOMPLETE` (distinct from `EVIDENCE_MISSING`); the event carries `stopReason`, `snapshotStopReason` and the counts reached. Pre-fix measured: `succeeded`; control: complete walk still succeeds |
| F-G17 | Medium | A file swapped to a FIFO hangs the walk. | **FIXED — working tree, uncommitted, unreviewed.** `O_NONBLOCK` + descriptor kind check; pre-fix the test times out at 20 s, post-fix it refuses in ms |
| F-G18 | Medium | `completeTaskActivity` accepts `succeeded` for an attempt recorded `failed` — the terminal write trusts its caller. | **FIXED — working tree, uncommitted, unreviewed.** `COMPLETION_CONTRADICTS_ATTEMPT`; pre-fix the same-session `complete` batch resolves |
| F-G14 | Medium | A recorded metadata anomaly (`hooksDirectoryLinkTarget`, oversize gitfile) is in the digest but nowhere a reviewer looks: `authoritative: true, changeCount: 0` shows nothing. | **FIXED — working tree, uncommitted, unreviewed.** `EvidenceSummary.gitAnomalies` + a durable `attempt.evidence_anomaly.v1` per attempt, both endpoints; nested `.git` included |
| F-G19 | Medium | A **failed baseline** is still silent — the F-G2 invariant is scoped to "if a baseline exists", so an agent that makes the tree unreadable *before* the baseline gets a run with no manifest and no failure. | **FIXED — working tree, uncommitted, unreviewed.** `EVIDENCE_BASELINE_FAILED` + event with `phase: initial`; pre-fix the attempt reports `succeeded` |
| F-G15 | Low | Non-UTF-8 name stops the walk; residual #6 claimed it continues lossily. | **IN FIX (doc)** |
| F-G16 | Low | `cleaned` / `quarantined` rows can survive with unreadable bytes; the guard runs on one pass. | **DECIDED + DOCUMENTED** — invariant scoped to *reclaim time*; afterwards the read path refuses (`410 ARTIFACT_GONE`, `integrity: unknown`). `EVIDENCE-INDEX.md` §"Artifact authority after the bytes are gone" |
| **F-G20** | **High** | A **parent** directory swapped for a link between its `readdir` and a child's `lstat` is resolved by the child's `lstat`; `O_NOFOLLOW` and `fstat` then agree by construction. Measured: a **complete, `authoritative: true`** snapshot carrying `/etc/passwd`, `/etc/group` and `/etc/hostname` digests. Detecting after the fact does not prevent the read. | **MITIGATED — DETECTION ONLY, working tree, uncommitted, unreviewed.** After-the-fact directory identity re-check (`dev`/`ino`/`ctimeMs`, `directoryIdentityVerdict`), contested subtree withdrawn, `complete: false` ⇒ `EVIDENCE_INCOMPLETE`; three tests in `snapshot-race.test.ts` with a no-swap negative control. Pre-fix: `complete: true` with the off-tree digest. **Prevention is not implemented** — needs `openat2(RESOLVE_BENEATH\|RESOLVE_NO_SYMLINKS)` or a descriptor-relative walk |


## Findings raised by the documentation claim audit (D-601 / D-602)

`DOC-CLAIM-AUDIT.md` classified 64 security claims: 38 proven, 13 unproven, 6 overstated,
7 false. The seven false ones are items here, because a false sentence is a defect in the
phase's record even when the code is sound. The 6 overstated and 13 unproven claims were
weakened in place, with the old wording named at the point of change or in a correction table
at the end of the document.

| ID | Location | Claim that was false | Status | Resolution |
|---|---|---|---|---|
| **D-01** | `TRUSTED-SNAPSHOT-DESIGN.md:41` | nested `.git` "recorded as metadata instead" — it was described nowhere | **DOC CORRECTED — code fix uncommitted** | Row and Exclusions section rewritten; F-G11 carries the code status |
| **D-02** | `TRUSTED-SNAPSHOT-DESIGN.md:104-108` | "the identity check makes the swap detected whenever the target is a different inode" | **DOC CORRECTED — detection implemented, uncommitted; prevention not implemented** | Named limitation 9 with the `openat2`/descriptor-walk trigger and the attacker's gain; F-G20, whose tests hold the window open with the walk's seam |
| **D-03** | `TRUSTED-SNAPSHOT-DESIGN.md:148-149` | "the only skip is `.git`" | **CLOSED** | Root's `.git` only; the bound stop reasons are named |
| **D-04** | `TRUSTED-SNAPSHOT-DESIGN.md:165-167` | non-UTF-8 names "represented lossily" — the walk stops and the entry is absent | **DOC CORRECTED — residual open** | Limitation 6 states the stop, the absence and the workspace-reuse consequence; G-E |
| **D-05** | `TRUSTED-SNAPSHOT-DESIGN.md:169-173` | a rewrite "cannot make a changed file look unchanged against a baseline" | **DOC CORRECTED — code fix uncommitted** | Limitation 7 states the measured falsehood and the uncommitted `ctimeMs` fix; F-G4 |
| **D-06** | `PHASE6-GATE-MATRIX.md:47` (G-03) | "imports only `readdir/readFile/lstat/readlink`" — no `readFile`, and `open` omitted | **CLOSED** | G-03 corrected; the property itself is verified (`snapshot.test.ts:346`) |
| **D-07** | `apps/worker/src/reaper.ts:525-528` | "No authority row without readable bytes … an invariant rather than a convention" — `cleaned`/`quarantined` rows keep authority over unreadable bytes | **OPEN — cannot be closed from documentation** | Recorded in this register and in G-21. The comment is source; D-602 may not edit source. It needs a one-line code change (see `DOC-CLAIM-AUDIT.md` §4 item 20) |

D-07 is the one finding this pass could not fix. The guard is narrower than its heading: it
runs in `reapOne` for non-terminal candidates (`reaper.ts:288` excludes
`completed/failed/cancelled/cleaned/cleanup_failed/quarantined`) and in `runOrphanSweep` for
`completed/failed` rows with `cleanedAt: null` (`:855-860`). A `cleaned` or `quarantined` row is
in neither set and is never revisited, so it can keep `authoritative: true` over bytes that are
gone. `reaper.test.ts:448` proves the reap path only.

## What the review confirmed as closed

Staging immunity, clean-filter dormancy, commit/hook/textconv/external-diff dormancy (each
reproduced with a positive control), the `candidate` removal, legacy defaults being
non-authoritative, test integrity (0 deleted test lines, no `.only`, no retry), and the
Phase 3–5 controls surviving unchanged.

## Still open, and why

| Gate | Item | Reason |
|---|---|---|
| A | Credential custody | Needs a separate service identity and a real process boundary — but first **Step 0**: uid 1000 has passwordless `sudo` and is in `lxd`, so any same-host uid split is theatre until that is removed. Host administration, separate authorisation, not attempted here. |
| R | Sandbox credential read | **Not tested.** Bind set and blocked egress are measured; no test opens the store from inside the sandbox (`CREDENTIAL-CUSTODY-ASSESSMENT.md`, experiment A-1). |
| M | Multi-tenancy | Per-endpoint scoping exists; no systematic adversarial suite. |
| N | I/O enforcement | `io.max` writable, controller delegated; process migration denied outside the wrapper. |
| O | Host-wide disk | Per-attempt ceilings work; no aggregate quota. |
| K | CI | No remote, no push credential, no Temporal service. Workflows authored, never executed. |
| P | Dependency advisories | 0 high/critical; lower severities unclassified. |
| Q | Backup / retention | Artifacts survive cleanup; no backup or enforcement. |

## The honest summary

O1 — the defect this phase existed to close — is closed on a boundary that can be stated
precisely: **no second execution authority for one reserved attempt.** The claim serialises
execution; it does not authenticate the operator, and a caller with Temporal access remains a
trusted capability.

Gate G removes the agent's authorship of its own evidence for three measured attacks, and
leaves signing, pre-image retention and mount policy open and labelled. It does **not** close:
a same-size rewrite with `mtime` restored (F-G4), a nested `.git` (F-G11), a parent directory
swapped for a link (F-G20), an incomplete manifest that still succeeds (F-G13), or the reaper's
authority claim over rows it never revisits (D-07). Those are the rows Gate G is still FAIL on.
