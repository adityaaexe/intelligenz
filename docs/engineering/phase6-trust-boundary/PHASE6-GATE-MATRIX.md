# Phase 6 — gate matrix

**Measured at:** `cfc1f26` — the commit the independent review's round 2 and `DOC-CLAIM-AUDIT.md`
measure. The working tree contains **uncommitted** corrections (root-only `.git` exclusion,
`ctimeMs` comparison, after-the-fact parent identity re-check, failure on an incomplete final
manifest). Where a row depends on one, the row says *uncommitted*. A row does not gain a status
from code no reviewer has seen.
**Supersedes:** `docs/engineering/phase5-recovery/PHASE5-GATE-MATRIX.md` for the rows this phase touched. Historical rows are not rewritten.

## Vocabulary

| Term | Means |
|---|---|
| **Enforced** | A control exists, is exercised on the real path, and a test fails when it is removed |
| **Unit-tested** | Logic verified in isolation; not proven on the real path |
| **Integration-tested** | Verified through the real service boundary (DB, Temporal) |
| **Adversarially verified** | A hostile attempt was made and failed |
| **Independently reviewed** | A reviewer who did not write it could not reproduce a bypass |
| **Blocked** | Infrastructure does not exist to test or run it |
| **Not tested** | No evidence either way. Never rounded up. |

## Matrix

| Gate | Area | Status | Evidence | What is missing |
|---|---|---|---|---|
| **A** | Credential custody | **OPEN** | `CREDENTIAL-CUSTODY-ASSESSMENT.md` | Store `-rw-------` uid 1000; broker is an in-process library (`opencode-cli.ts:711`); no process boundary. **Above the gate:** uid 1000 has passwordless `sudo` and is in `sudo`/`lxd`, and every parent directory of the store is `0775` owned by uid 1000, so `0600` is not the control (`namei -l`). A separate broker uid is theatre until **Step 0** (remove `sudo`/`lxd`) lands. A second secret, `mcp-auth.json`, sits in the same directory |
| **B** | Approval binding | **Enforced** | `taskContentHash` recomputed at execution; `APPROVAL_ATTEMPT_MISMATCH` tests | — |
| **C** | Server-derived risk | **Enforced** | `derivedRiskClass`, `riskPolicyVersion`, `riskSource` | — |
| **D** | Per-attempt disk ceiling | **Enforced** | ext4 loop volumes; kernel `ENOSPC` proven, host unaffected | Host-wide allocation still **OPEN** (see G) |
| **E** | Output cap | **Enforced** | Shared `ArtifactBudget`, streamed copy, truncation marker + sidecar | — |
| **F** | VM-required isolation | **Enforced (fail-closed)** | No `/dev/kvm`, no `vmx`/`svm`; VM tier refuses rather than downgrades | Level-3 isolation itself is **BLOCKED** |
| **G** | **Artifact/diff integrity** | **FAIL** — review round 2 on `cfc1f26` | The three git attacks are **closed and independently reproduced as closed**. F-G1/F-G2 are closed; F-G3's **measured path** is closed, but its guard is not an invariant — three ways to leave an authoritative row with unreadable bytes remain (G-16) | A nested `sub/.git` is an **undescribed write area** (F-G11: `changeCount 0`, digest identical to baseline); `ctime` is not compared, so the documented same-size bound is false (F-G4); a **parent directory swapped for a link** yields a complete, authoritative snapshot carrying host-file digests (F-G20); an incomplete manifest still yields a `succeeded` task (F-G13) |
| **H** | Approval → attempt atomicity (O1) | **PASS** | One-shot claim at the launch site, identity context-only, 4 review rounds | Serialises, does not authenticate the operator |
| **I** | Claim release (F4) | **PARTIAL** | Release on the recorded `(workflowId, runId)` pair; live claims never released | Liveness arm re-tested after N12; no unclaim by design |
| **J** | Activity write authority | **PASS for `Task` / PARTIAL for the class** | `persistResult`, `completeTask`, `emitEvent`, `recordStart` | Five other aggregate namespaces still writable by name (N15) |
| **K** | CI execution | **BLOCKED** | `.github/workflows/ci.yml` authored, never executed | No remote, no push credential, no Temporal service |
| **L** | Isolation stability | **PASS** | 1/6 → root cause measured (14.77% designed bucket); 15 consecutive green runs | — |
| **M** | Multi-tenancy | **OPEN** | Per-endpoint scoping verified | No systematic adversarial cross-tenant suite |
| **N** | I/O enforcement | **PARTIAL** | `io.max` writable, controller delegated | Process migration denied outside `worker-with-cgroup.sh` |
| **O** | Host-wide disk governance | **OPEN** | Per-attempt volumes bounded | No aggregate quota across attempts |
| **P** | Dependency advisories | **OPEN (no high/critical)** | `pnpm audit --audit-level high` → 0 high, PostCSS pinned to 8.5.32 | Lower severities unclassified |
| **Q** | Backup / retention | **OPEN** | Artifacts survive cleanup; `keepArtifacts` | No backup, no retention policy enforcement |
| **R** | Credentials in sandbox | **PARTIAL — not tested** | No credential bind in the launcher argv; `izbroker/<key>` indirection; no network | The read is not attempted. `sandbox.test.ts:96` asserts one writable bind and `:51` measures blocked egress; nothing opens the store from inside the sandbox, so "the sandbox cannot read the credential" is an inference. Experiment in `CREDENTIAL-CUSTODY-ASSESSMENT.md` |

## Gate G acceptance matrix

| ID | Condition | Status |
|---|---|---|
| G-01 | Initial snapshot precedes agent execution | **Verified** — source-position test (`evidence-capture-order.test.ts:58`) + inline capture at `execute-agent.ts:701` (at `cfc1f26`; `:786` in the working tree) before cgroup/state/execute |
| G-02 | Final snapshot follows confirmed termination | **Verified** — `:844` success, `:1149` thrown path at `cfc1f26` (`:936`, `:1254` working tree) |
| G-03 | Authority from raw filesystem observation | **Verified** — `snapshot.ts` imports `readdir`, `lstat`, `open` and `readlink` from `node:fs/promises` (`snapshot.ts:3`) and no `child_process` (asserted at `snapshot.test.ts:346`); content is hashed through a descriptor, not a repository-configurable program. The row previously listed `readFile` and omitted `open`; the property held, the enumeration was wrong. |
| G-04 | Git index/staging cannot shape authority | **Verified** — attack 1, reproduced by the reviewer |
| G-05 | Clean/smudge filters cannot shape authority | **Verified** — attack 2 + positive control, reproduced |
| G-06 | Commit/hooks/external diff cannot shape authority | **Verified** — attack 3 + dormant-helper markers, reproduced |
| G-07 | Traversal confined | **PARTIAL** — `F-G1 closed`: `.git/hooks -> /etc` now 0 entries, target recorded, `/etc/passwd` hash absent (test `snapshot-escape.test.ts:63`). `F-G11`: at `cfc1f26` a nested `sub/.git` was excluded at any depth and described nowhere, so a write inside it changed no entry and no digest. **Missing:** a committed, reviewed root-only exclusion (working tree only, test untracked); a descriptor-relative walk. A parent directory swapped for a link is **detected after the fact, not prevented** (F-G20): the directory's `dev`/`ino`/`ctimeMs` are re-read after its children, the contested subtree is withdrawn, `stopReason: 'parent-replaced'`, and the attempt fails (*three tests in `snapshot-race.test.ts`, one of them the no-swap negative control*; limitation 9 of `TRUSTED-SNAPSHOT-DESIGN.md`). A swap inside `listDirectory`'s own `lstat`→`readdir` window remains undetected by either check |
| G-08 | Snapshot consistency enforced | **PARTIAL** — `O_NOFOLLOW` + `fstat` identity + `mtime` re-check catch different-inode swaps (`snapshot-race.test.ts:54`, `:89`); **`ctime` is not compared at `cfc1f26`**, so a same-size write with `mtime` restored produces a digest identical to baseline (F-G4). **Missing:** the working-tree `ctimeMs` comparison (`snapshot.ts:388`, `:405-413`; tests `snapshot-race.test.ts:140`, `:175`) is uncommitted and has no end-to-end two-snapshot test; the parent-swap window (F-G20) is detected after the fact in the working tree **by three tests with a negative control**, and is not prevented; a FIFO swapped in after classification is refused instead of blocking the walk (F-G17, `snapshot-race.test.ts:104`) |
| G-09 | Canonical manifest deterministic | **Verified** — byte sort via `Buffer.compare`, digest recomputed from body |
| G-10 | Change manifest from trusted snapshots only | **Verified** — `buildChangeManifest(initial, final)` |
| G-11 | Digests persisted | **Verified** — `ExecutionWorkspace.initial/finalManifestDigest`, `snapshotAt` |
| G-12 | Artifact authority server-controlled | **Verified** — `authoritative = evidence.authoritative && workspaceId !== null`; adapter candidate removed |
| G-13 | Tamper detected | **PARTIAL** — checksum and truncation edits refused, but `verifyManifestFile` never parses the body: `complete:false` inside an envelope claiming `authoritative:true` verifies (F-G6). Not agent-reachable. |
| G-14 | Missing artifact behaviour | **Verified** — existing 410 contract preserved |
| G-15 | Tenant/task/attempt provenance | **Verified** — derivation from `(workflowRunId, attemptNumber)` scoped by org+task. Replay binding uses the newest attempt/run rather than the execution in context (F-G10, PARTIAL). |
| G-16 | Cleanup cannot destroy unpersisted evidence | **FAIL** — the reaper deletes `evidence/` while keeping `authoritative:true` rows with unreadable URIs (F-G3, measured `removed: true, evidenceKept: false`) |
| G-17 | Failure cannot masquerade as verified success | **PARTIAL** — `F-G2 closed`: `chmod 000` ⇒ attempt and task `failed`, `EVIDENCE_MISSING`, `attempt.evidence_failed.v1`. At `cfc1f26` an *incomplete* (not missing) manifest still yields `succeeded` with no event (F-G13), and a failed baseline is silent (F-G19). The working tree fails all three with **distinct** codes — `EVIDENCE_MISSING`, `EVIDENCE_INCOMPLETE`, `EVIDENCE_BASELINE_FAILED` — each with its own event payload (stop reason + counts for the bounded walk, `phase: initial` for the baseline), and `completeTaskActivity` refuses `succeeded` for an attempt recorded `failed` (F-G18). **Uncommitted, unreviewed**; the pre-fix failures are captured per finding |
| G-18 | Migration safe | **Verified** — fresh DB, 8 migrations, 16 tables, `authoritative NOT NULL DEFAULT false` |
| G-19 | Prior trust controls intact | **Verified** — claim/boundary/claim-release/identity suites re-run |
| G-20 | No unresolved critical/high defect | **FAIL** — F-G11 and F-G20 (both High) are open at `cfc1f26`. The working tree closes F-G11 (root-only `.git` exclusion, `snapshot-nested-git.test.ts`) and adds F-G20's **detection** (parent identity re-check, subtree withdrawal, `snapshot-race.test.ts`); F-G20's prevention is explicitly **not implemented**. Nothing is committed or reviewed, so the reviewed commit still fails the row |
| G-21 | Documentation claims are provable | **FAIL** — `DOC-CLAIM-AUDIT.md` (D-601) classified 64 security claims: **38 proven, 13 unproven, 6 overstated, 7 false**. The four statements this row named are all confirmed false: same-size bound (`TRUSTED-SNAPSHOT-DESIGN.md:169-173`), parent-swap detection (`:104-108`), nested-`.git` metadata (`:41`), and the reaper's "any authority row" (`apps/worker/src/reaper.ts:525-528`, a source comment). D-602 corrected the documents: every false and overstated sentence **in a Markdown document** is replaced or labelled *not proven*, with the old wording named at the point of change or in a correction table. The surviving limitations are named with triggers. **Still FAIL**: uncommitted fixes cannot be cited as proof. The reaper comment now states its scope instead of contradicting it (F-G16): the demotion runs **at reclaim time**, `cleaned`/`quarantined` rows are deliberately not revisited, and the read path refuses a gone file (`410 ARTIFACT_GONE`, `integrity: unknown`) — decision recorded in `EVIDENCE-INDEX.md` §"Artifact authority after the bytes are gone" |

**Gate G is FAIL, not PARTIAL.** The row above used to say "every other row is verified; one
row is not". That was wrong on its face once round 2 landed: G-07, G-08, G-13, G-16, G-17, G-20
and G-21 are not verified. A gate with one High defect and six partial rows is a gate that is
open, and rounding it to "partial" is how a matrix stops being evidence.

## Deliberate non-claims

- Bubblewrap is **not** VM isolation. It is `restricted-shared-kernel` and labelled so.
- The sandbox is **not proven unable to read the credential store**. The bind set and blocked
  egress are measured; the read attempt does not exist (Gate R).
- The claim **serialises** execution; it does not authenticate the operator.
- A manifest hash is **content identity**, not a signature. No key, no signing, no non-repudiation.
- Per-attempt resource limits do **not** mean host-wide governance.
- `pnpm audit` clean at `high` does **not** mean dependency risk is closed.
