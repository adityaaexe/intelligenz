# Phase 6 — gate matrix

**Commit:** `9461d2773a2902dee91d0f36a22977356548c01e`
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
| **A** | Credential custody | **OPEN** | `CREDENTIAL-CUSTODY-ASSESSMENT.md` | Store `-rw-------` owned by worker uid 1000; broker is an in-process library (`opencode-cli.ts:711`). No process boundary exists. |
| **B** | Approval binding | **Enforced** | `taskContentHash` recomputed at execution; `APPROVAL_ATTEMPT_MISMATCH` tests | — |
| **C** | Server-derived risk | **Enforced** | `derivedRiskClass`, `riskPolicyVersion`, `riskSource` | — |
| **D** | Per-attempt disk ceiling | **Enforced** | ext4 loop volumes; kernel `ENOSPC` proven, host unaffected | Host-wide allocation still **OPEN** (see G) |
| **E** | Output cap | **Enforced** | Shared `ArtifactBudget`, streamed copy, truncation marker + sidecar | — |
| **F** | VM-required isolation | **Enforced (fail-closed)** | No `/dev/kvm`, no `vmx`/`svm`; VM tier refuses rather than downgrades | Level-3 isolation itself is **BLOCKED** |
| **G** | **Artifact/diff integrity** | **FAIL** — review round 1 on `9461d27` | Git attacks closed and independently reproduced as closed (staging, clean filter, commit, textconv, external diff, hooks — all with positive controls) | **The walk can still leave the tree** (F-G1) and **the agent can delete its evidence** (F-G2). Correction in flight; G-04/G-05/G-13 reopen. |
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
| **R** | Credentials in sandbox | **Enforced** | No credential mount; `izbroker/<key>` indirection; no network | — |

## Gate G acceptance matrix

| ID | Condition | Status |
|---|---|---|
| G-01 | Initial snapshot precedes agent execution | **Verified** — source-position test + inline capture at `execute-agent.ts:613` before cgroup/state/execute |
| G-02 | Final snapshot follows confirmed termination | **Verified** — `:756` success, `:1007` thrown path |
| G-03 | Authority from raw filesystem observation | **Verified** — `snapshot.ts` imports only `readdir/readFile/lstat/readlink` |
| G-04 | Git index/staging cannot shape authority | **Verified** — attack 1, reproduced by the reviewer |
| G-05 | Clean/smudge filters cannot shape authority | **Verified** — attack 2 + positive control, reproduced |
| G-06 | Commit/hooks/external diff cannot shape authority | **Verified** — attack 3 + dormant-helper markers, reproduced |
| G-07 | Traversal confined | **FAIL** — `isContained` is lexical; `.git/hooks -> /etc` read 98 foreign entries including `/etc/passwd`'s hash (F-G1) |
| G-08 | Snapshot consistency enforced | **FAIL** — a 96 MiB same-size in-place rewrite produced `complete: true` with a digest matching neither the original nor the final bytes (F-G4); `lstat`→`open` race reasoned but not reproduced (F-G5) |
| G-09 | Canonical manifest deterministic | **Verified** — byte sort via `Buffer.compare`, digest recomputed from body |
| G-10 | Change manifest from trusted snapshots only | **Verified** — `buildChangeManifest(initial, final)` |
| G-11 | Digests persisted | **Verified** — `ExecutionWorkspace.initial/finalManifestDigest`, `snapshotAt` |
| G-12 | Artifact authority server-controlled | **Verified** — `authoritative = evidence.authoritative && workspaceId !== null`; adapter candidate removed |
| G-13 | Tamper detected | **PARTIAL** — checksum and truncation edits refused, but `verifyManifestFile` never parses the body: `complete:false` inside an envelope claiming `authoritative:true` verifies (F-G6). Not agent-reachable. |
| G-14 | Missing artifact behaviour | **Verified** — existing 410 contract preserved |
| G-15 | Tenant/task/attempt provenance | **Verified** — derivation from `(workflowRunId, attemptNumber)` scoped by org+task. Replay binding uses the newest attempt/run rather than the execution in context (F-G10, PARTIAL). |
| G-16 | Cleanup cannot destroy unpersisted evidence | **FAIL** — the reaper deletes `evidence/` while keeping `authoritative:true` rows with unreadable URIs (F-G3, measured `removed: true, evidenceKept: false`) |
| G-17 | Failure cannot masquerade as verified success | **FAIL** — `chmod 000` on one directory ⇒ no manifest, task still `succeeded` (F-G2) |
| G-18 | Migration safe | **Verified** — fresh DB, 8 migrations, 16 tables, `authoritative NOT NULL DEFAULT false` |
| G-19 | Prior trust controls intact | **Verified** — claim/boundary/claim-release/identity suites re-run |
| G-20 | No unresolved critical/high defect | **PENDING** — independent review in flight on `9461d27` |

**Gate G is PARTIAL until G-20 closes.** Every other row is verified; one row is not, and a gate is not closed because 19 of 20 are green.

## Deliberate non-claims

- Bubblewrap is **not** VM isolation. It is `restricted-shared-kernel` and labelled so.
- The claim **serialises** execution; it does not authenticate the operator.
- A manifest hash is **content identity**, not a signature. No key, no signing, no non-repudiation.
- Per-attempt resource limits do **not** mean host-wide governance.
- `pnpm audit` clean at `high` does **not** mean dependency risk is closed.
