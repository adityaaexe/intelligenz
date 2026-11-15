# Phase 6 — remediation register

**Commit:** `9461d2773a2902dee91d0f36a22977356548c01e`
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
| N4 class | `emitEventActivity` / `recordStartActivity` unauthenticated | **CLOSED** | Authority before first write; pre-dispatch failure path preserved |

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
| G-E | Non-UTF-8 filenames are represented lossily by the `readdir` string API | **OPEN — documented** | A name that is not valid UTF-8 cannot be represented faithfully through this API |
| G-F | No signing: a hash is content identity, not authenticity | **OPEN — by design** | Stated in the design doc and the gate matrix; no key exists |
| G-G | The flow covers three git attacks, not all filesystem attacks (no mount crossing, no hard-link inode test) | **OPEN — documented** | `ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md` §"honest gaps" |

## Findings raised by the Gate G independent review (`9461d27` — **FAIL**)

| ID | Severity | Finding | Status |
|---|---|---|---|
| **F-G1** | **High** | `.git/hooks` as a directory symlink escaped the tree: 98 entries read from `/etc`, including `/etc/passwd`'s SHA-256, reflected in the manifest. `isContained` is lexical; `readdir` followed the symlinked parent. | **IN FIX** |
| **F-G2** | **High** | `chmod 000` on one directory ⇒ `EACCES` ⇒ `captureFinalEvidence` returns `null` ⇒ **task still `succeeded`**, no manifest, no signal. Absence of evidence indistinguishable from "no changes". | **IN FIX** |
| **F-G3** | Medium | The reaper deletes `evidence/` after preserving artifacts; `authoritative:true` rows keep URIs that can never be read (measured). | **IN FIX** |
| F-G4 | Medium | A 96 MiB same-size in-place rewrite produced `complete: true` with a digest matching neither the original nor the final bytes; the design doc overstates what the size check detects. | **IN FIX (doc + `O_NOFOLLOW`/`fstat`)** |
| F-G5 | Medium | `lstat`→`open` race: no `O_NOFOLLOW` on the read, so a file could be swapped for a symlink between check and read. Reasoned, not reproduced. | **IN FIX** |
| F-G6 | Medium | `verifyManifestFile` is self-consistency only — it never parses the body and never binds to `ExecutionWorkspace` digests. | **IN FIX** |
| F-G7 | Low | `.git` metadata changes never appear as a change-manifest row. | Documented |
| F-G8 | Low | Two inaccurate doc claims, including "no `child_process` under `packages/workspace-manager/src`" while `manager.ts:1` imports it. | **IN FIX (doc)** |
| F-G9/F-G10 | Info | Replay binding uses the newest attempt/run rather than the execution in context; no live probe of the process-tree guarantee (it rests on `--unshare-pid` at `sandbox.ts:322`). | Documented |

## What the review confirmed as closed

Staging immunity, clean-filter dormancy, commit/hook/textconv/external-diff dormancy (each
reproduced with a positive control), the `candidate` removal, legacy defaults being
non-authoritative, test integrity (0 deleted test lines, no `.only`, no retry), and the
Phase 3–5 controls surviving unchanged.

## Still open, and why

| Gate | Item | Reason |
|---|---|---|
| A | Credential custody | Needs a separate service identity and a real process boundary. Not attempted here. |
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
leaves signing, pre-image retention and mount policy open and labelled.
