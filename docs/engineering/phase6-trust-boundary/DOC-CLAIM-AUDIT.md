# Phase 6 — documentation claim audit (D-601)

**Task:** D-601. **Mode:** read-only. No source was edited, no test was executed. The test
runner and the shared database were held by another agent for the duration of this audit.

**Scope:** every document under `docs/engineering/phase6-trust-boundary/`, plus
`TRUST-BOUNDARY-CLOSURE.md`, `AG-603-*` and `AG-604-*`.

**Verdict baseline:** the documents as they stand in the working tree, judged against the
code and tests at `HEAD = cfc1f26` — the commit the documents name and the tree the
independent review measured. The working tree contains an uncommitted fix to
`packages/workspace-manager/src/snapshot.ts` (root-only `.git` exclusion, `ctimeMs`
comparison, `git.anomalies`). Where that fix changes the answer, the row says so and
Appendix A records the drift; it is not silently counted as shipped.

**Method.** Each candidate sentence was read in place, the code path it describes was read,
and the test file was searched for a test that asserts that property. No test was run, so
"proven" below means *the named test asserts the property and would fail without the code,
as judged by reading the assertion* — not "the suite is green".

**Verdict definitions used here**

| Verdict | Meaning |
|---|---|
| **proven** | A named test asserts this exact property and would fail without the code. `file:line` cited. |
| **unproven** | The code implements it, or appears to, but no test asserts it. Implemented is not proven. |
| **false** | The code does not do what the sentence says, or a measurement contradicts it. |
| **overstated** | Directionally true for the tested case; the strong word (*never*, *any*, *only*, *every*, *cannot*) claims more than the test or the code establishes. |

---

## 1. Status of the four sentences reported by the independent reviewer

The brief lists four. Current document state:

| # | Reported sentence | Still present? | Where |
|---|---|---|---|
| 1 | "the size check detects mutation" | **Partly corrected.** The gross form is gone: `TRUSTED-SNAPSHOT-DESIGN.md:72-81` now states plainly what a same-size rewrite defeats. But the surviving consistency point still says a writer that "rewrote during the read is detected" on `size`/`mtimeMs` alone, and the Limitations paragraph still asserts the baseline bound the reviewer measured false. | `TRUSTED-SNAPSHOT-DESIGN.md:67-68`, `:169-173`; `ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md:75` |
| 2 | "the identity check makes the swap detected whenever the target is a different inode" | **Present, verbatim.** | `TRUSTED-SNAPSHOT-DESIGN.md:106-108` |
| 3 | `.git` metadata described for the root only while `.git` was excluded at any depth | **Present.** The table row still says "excluded at any depth … recorded as metadata instead"; the only-skip paragraph repeats it. | `TRUSTED-SNAPSHOT-DESIGN.md:41`, `:148-149` |
| 4 | the reaper guard covers "any authority row" | **Present in the code comment**, not in a Markdown document. `PHASE6-GATE-MATRIX.md:63` already records it as measured false. | `apps/worker/src/reaper.ts:525-528` |

Two of the four are unchanged in the documents; one was reworded into a narrower but still
false bound; the fourth lives in source, and the Phase 6 matrix is honest about it.

---

## 2. The table

### `TRUSTED-SNAPSHOT-DESIGN.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:24-29` | "A `.git/hooks` that is a symbolic link … contributes **no** hook entries" | **proven** | `snapshot-escape.test.ts:63` asserts `git.hooks === []`, `hooksDirectoryLinkTarget === '/etc'`, and that neither the snapshot body nor the manifest contains `/etc/passwd`'s digest. |
| `:37` | "Every directory is enumerated through one helper … a symlink is recorded by target and **never listed**. Used for the content walk and for `.git/hooks`." | **proven** | `snapshot-escape.test.ts:63` (hooks link not enumerated, zero entries) and `snapshot.test.ts:109` (content symlink recorded, target not read). Removing `listDirectory` for either consumer fails one of them. |
| `:38` | "Lexical containment of every path string … `isContained()` on every directory **and** every entry; throws `SNAPSHOT_PATH_ESCAPE`" | **unproven** | No test triggers `SNAPSHOT_PATH_ESCAPE`; the only mention in the suite is a comment (`snapshot-escape.test.ts:17`). Code: `snapshot.ts:705`, `:741` (HEAD). The row is also silent about parent components, which is the false claim at `:106-108`. |
| `:39` | "Contested entries are refused — `open(O_RDONLY \| O_NOFOLLOW)` + `fstat`; `dev`/`ino`/`size` compared with the `lstat`" | **proven** | `snapshot-race.test.ts:54` holds a stale `lstat` across a swap and asserts `UnstableEntryError`; `:89` covers the size-change arm; `:74` is the positive control (an unchanged file still hashes), so the refusal is about the swap. |
| `:41` | "`.git` excluded at any depth — skipped in the walk, recorded as metadata instead" | **false** | At `cfc1f26`, `snapshot.ts:732` skips `.git` at every depth while `readGitMetadata` reads only `<root>/.git`; nested `.git` is recorded nowhere. Measured: `FINAL-INDEPENDENT-REVIEW.md:2530-2558` (`changeCount 0`, digest identical to baseline). In the working tree the code is root-only, so the first half becomes false too — see Appendix A. |
| `:42` | "Definite git metadata is not read through links … `.git/HEAD` and `.git` itself are read with `O_NOFOLLOW`" | **proven** | `snapshot-escape.test.ts:148` (symlinked `.git` recorded, target not walked), `:179` (gitfile hashed without following), `:203` (`HEAD` link not read). |
| `:43` | "Deterministic order — `Buffer.compare` on path bytes, not `Array.sort`" | **proven** | `snapshot.test.ts:160` asserts the recorded order equals a `Buffer.compare` sort over astral/unicode names. An `Array.sort` regression fails it. |
| `:44` | "Deterministic truncation — … a bounded walk stops in the same place on every host" | **unproven** | `snapshot.test.ts:279` asserts the count and `stopReason`, not that two hosts cut at the same entry. The sorted frontier makes it likely; no test asserts the cut point. |
| `:45` | "Root must be a real directory — rejects symlinked or non-directory root" | **proven** | `snapshot.test.ts:264` asserts `SnapshotError` for both a regular file and a symlinked root. |
| `:67-68` | "`size` and `mtimeMs` are re-read after hashing; a writer that appended or rewrote during the read is detected." | **overstated** | At `cfc1f26` the after-check compares only `size`/`mtimeMs` (`snapshot.ts:338`). A same-size rewrite that restores `mtime` leaves both unchanged; measured `complete: true` with the digest equal to baseline (`FINAL-INDEPENDENT-REVIEW.md:2340-2362`). The document contradicts itself eight lines later. |
| `:69-70` | "A short read with an unchanged descriptor size would be a digest covering fewer bytes than it claims." | **unproven** | The check exists (`snapshot.ts:347`), but no test produces a short read with an unchanged descriptor size. `snapshot-race.test.ts:89` changes the size, which the size check catches first. |
| `:104-108` | "The identity check makes the swap *detected* whenever the target is a different inode, which is every case except a same-inode/same-size substitution." | **false** | `walk` enumerates a directory at `snapshot.ts:716` (HEAD), then `lstat`s each child at `:753`. A parent swapped for a link between those two points is resolved by the child `lstat`; `open`/`fstat` then agree by construction. Measured: a **complete** snapshot carrying `/etc/passwd`, `/etc/group` and `/etc/hostname` digests (`FINAL-INDEPENDENT-REVIEW.md:2384-2402`). |
| `:115-116` | "On exceed the snapshot is marked `complete: false` with a `stopReason`" | **proven** | `snapshot.test.ts:279` (`max-entries`), `:306` (`maxTotalBytes`), `:319` (bounded digest differs). |
| `:118-125` | "An incomplete snapshot is **not** authority, and the chain enforces it end to end" | **proven** | `evidence-provenance.test.ts:667` (bound workspace, incomplete walk ⇒ `Artifact.authoritative === false`); `:437` (authoritative envelope over an incomplete body is refused). Producer gates: `evidence.ts:426` (`HEAD`; `authoritative: manifest.complete`), `persist-result.ts:365`. |
| `:136` | "a test asserts that recomputation matches and that any edit changes the digest (`change-manifest.test.ts:347-348`)" | **proven** | `change-manifest.test.ts:347` recomputes `sha256(serialiseManifest(manifest))` and asserts three separate one-field edits move the serialisation. |
| `:148-149` | "The only skip is `.git`, which is excluded as content and captured as metadata." | **false** | At `cfc1f26` the walk also skips `.`/`..` and any name containing a separator (`snapshot.ts:732`), and `maxEntries`/`maxTotalBytes` stop the walk. "Only skip" is wrong on the defensive cases and ignores bounded truncation; and the metadata half is false for nested `.git` (row `:41`). |
| `:165-167` | "such an entry would be represented lossily rather than rejected" (non-UTF-8 name) | **false** | `readdir` returns a lossy string; `lstat` on the joined string fails; `walk` sets `stopReason: 'unreadable'` and breaks (`snapshot.ts:753-756`, `:810` at HEAD). Measured: `complete: false`, entry absent, file hidden, and every later manifest of that workspace is incomplete (`FINAL-INDEPENDENT-REVIEW.md:2614-2623`). |
| `:169-173` | "It **cannot** make a changed file look unchanged against a *baseline*, and a later snapshot reports a different digest" | **false** | Measured on a 1 GiB file: first 4 KiB rewritten to `0x42` during the final walk with `mtime` restored at ns precision ⇒ final digest **identical** to baseline, `changeCount: 0`, `authoritative: true` (`FINAL-INDEPENDENT-REVIEW.md:2353-2362`). The `ctime` fix in the working tree closes this mechanism but is uncommitted and has no end-to-end test. |
| `:159-160` | "Two paths to one inode are hashed twice … A change through one path appears at both" | **unproven** | No test creates a hard link and asserts the double description. The reviewer measured it (`FINAL-INDEPENDENT-REVIEW.md:2520`), the suite does not. |

### `ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:71` | "symlink to `/etc/passwd` … target **never** opened" | **proven** | `hostile-repository.test.ts:133` asserts the link is recorded with its target, `/etc/passwd`'s digest is absent, and every hostile helper's marker directory is empty. |
| `:72` | "path escape `..` / absolute … `SNAPSHOT_PATH_ESCAPE`, walk aborts" | **unproven** | Same absence as `TRUSTED-SNAPSHOT-DESIGN.md:38`: no test triggers the throw. |
| `:73` | "symlinked root … rejected" | **proven** | `snapshot.test.ts:264`. |
| `:74` | "directory vanishes mid-walk → `stopReason: 'unreadable'`, not ignored" | **unproven** | Implemented at `snapshot.ts:716-723` (HEAD); no test deletes a queued directory. The claim is about a behaviour nothing exercises. |
| `:75` | "file changes during read — size-vs-bytes check — inconsistent entry detected" | **overstated** | The size-vs-bytes check (`snapshot.ts:338-350` at HEAD) detects a **short read**, not a content mutation. A same-size rewrite with `mtime` restored leaves size and bytes equal and is accepted at `cfc1f26`; only the uncommitted `ctime` comparison changes that. The table names the wrong check. |
| `:87` | "A truncated manifest is written and is **never** authoritative." | **proven** | `evidence-provenance.test.ts:667` asserts `Artifact.authoritative === false` for a bound workspace with an incomplete walk; `:437` refuses an authoritative envelope over an incomplete body. Two independent gates, one test each. |

### `ARTIFACT-INTEGRITY-ROOT-CAUSE.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:127` | "Which paths were added, modified, deleted? **Yes** — authoritative" | **proven** | `change-manifest.test.ts:57` (staged), `:106` (clean filter), `:161` (commit) each assert the real modification with the on-disk hash while git reports nothing. |
| `:130` | "Did the repository's own config, index or hooks change? **Yes**, recorded as a separate metadata digest" | **proven** | `snapshot.test.ts:207` (config change moves the digest without moving entries), `:180` (config, index and named hooks digested). Scope is the root `.git` only — the sentence does not claim otherwise, so it is accurate as written. |
| `:115` | "A baseline the agent **cannot touch**, taken before it runs" (stated as a requirement; implemented in Phase 6) | **proven** | `evidence-isolation.test.ts:61` (the evidence directory is invisible inside the sandbox by host path and by relative route) and `:87` (a write attempt leaves the protected bytes identical); `evidence-capture-order.test.ts:58` for "before it runs". |

### `AG-603-IDENTITY-AND-AUTHORITY.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:37` | "`executionIdentity()` takes **no argument** and reads the activity context only" | **proven** | `execution-identity.test.ts:605` asserts the zero-argument signature structurally; `:554` asserts the claim written inside a real workflow equals the server-minted run id. |
| `:39` | "`requireExecutionClaim` refuses with that code before its first read" | **proven** | `execution-identity.test.ts:259` calls the launch site with no context and asserts `EXECUTION_IDENTITY_UNAVAILABLE` plus zero writes (no claim, no `AgentRun`, no status change). |
| `:50` | "**Nothing** in `src/` reads an identity from a parameter." | **overstated** | `claimExecution(identity: ClaimIdentity)` reads `identity.workflowRunId` (`claim.ts:303-320`), and the document itself says so at `:59-61`. The activity-input surface is clean — `execution-identity.test.ts:614` asserts no identity field on the inputs — but "nothing in `src/`" is not true. |
| `:55-56` | "A standalone activity has no `workflowExecution` and therefore no identity; a workflow-dispatched activity cannot override it." | **proven** | `execution-identity.test.ts:467` and `:498` dispatch a real standalone activity carrying the victim's run id on a real worker: refused, one attempt row, reservation intact. |
| `:165` | "the named attempt carries a claim → `requireExecutionClaim` — the holder, **and only the holder**" | **proven** | `execution-boundary.test.ts:948` (completion for an attempt another execution holds is refused); `claim.ts:444-520` compares the row's claim to the context run id. |
| `:166` | pre-dispatch arm requires "this task's own execution … **and** no attempt of this task may be running or claimed by anybody else" | **unproven** | The identity half is tested (`execution-boundary.test.ts:984`, `:1018`). The "no foreign attempt" conjunct (`claim.ts:765-777`) has no test that seeds a running foreign attempt against an otherwise-authorised pre-dispatch call. The sentence asserts both. |
| `:216` | "The API **always** starts `task-<taskId>`" | **unproven** | Both API start paths use the prefix (`tasks.service.ts:792`, `orchestrator/orchestrator.service.ts:145`), but no test asserts the workflow id the API starts. Code inspection only. |

### `AG-604-CLAIM-IDENTITY-AND-WRITE-AUTHORITY.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:33` | "`claimedByWorkflowId` … written in the **same** conditional `updateMany` as the run id and `claimedAt`, read from `Context.current()`" | **proven** | `execution-boundary.test.ts:868` takes the claim from the shipped validation path and asserts both ids equal the values the Temporal server put in the activity context (the workflow id is deliberately not `task-<taskId>`). Atomic co-write by inspection: `claim.ts:307-331`. |
| `:35` | "A claim with no recorded workflow id is **skipped** (`skipped_unknown`), not released" | **proven** | `execution-boundary.test.ts:1678` seeds `claimedByWorkflowId: null`, asserts the row is not even a candidate, the probe is never asked, and zero release events exist. |
| `:36` | "The release predicate requires the pair, and clears all three claim columns" | **proven** | `claim-release.ts:309-337`; `execution-boundary.test.ts:1140-1150` asserts `status === 'failed'` and `claimedByWorkflowId`/`claimedByWorkflowRunId`/`claimedAt` all `null`, with exactly one audit row carrying both ids. |
| `:68-71` | "The arm now requires `status ∈ {failed, cancelled}` … and refuses anything else" | **proven** | `execution-boundary.test.ts:1744` asserts `succeeded` for a task with no attempts and no `AgentRun` is refused. |
| `:103` | "a start (`queued → running`) — **refused** — there is no pre-dispatch case" | **proven** | `execution-boundary.test.ts:1962` (standalone) and `:1989` (workflow holding no claim) both refuse; `:2023` allows the claim-authorised start. |
| `:145-150` | "Such a row can be neither claimed … nor adopted … nor completed … nor reaped … **Its task never reaches a terminal state**" | **overstated** | The four workflow paths are accurate (`classifyLostClaim`, `adoptReservedAttempt`, the `foreign` predicate, the `queued`-only release). "Never reaches a terminal state" ignores `POST /cancel`: `tasks.service.ts:1031` accepts a `running` task and `:1064` writes `cancelled`. The workflow cannot finish it; an operator can still cancel it. |

### `TRUST-BOUNDARY-CLOSURE.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:29-36` | "`requireExecutionClaim()` … called as the **first act** … before `getWorkerConfig()`, before the runtime adapter, before the task read, before `startAttempt` … Anything else throws … with zero writes." | **proven** | `execution-identity.test.ts:637` asserts the guard precedes the runtime, adoption and the single launch call; `:259` asserts the refusal writes nothing. The config/task-read positions are code-true (guard at `execute-agent.ts:190`, config at `:198`, task read at `:202`, `HEAD`). |
| `:60-65` | "The `startAttempt` compare-and-swap now includes `claimedByWorkflowRunId` … `findFirst` is deliberately **not** filtered on the claim … refuses instead (`EXECUTION_ATTEMPT_TAKEN`)" | **proven** | `execution-boundary.test.ts:507` asserts the non-owner is refused and the owner then adopts the same row; `attempts.ts:214-247`. |
| `:73-76` | "refuses with `EXECUTION_CLAIM_REFUSED` when `attemptId` is absent … `requireExecutionClaim` refuses the same case independently" | **proven** | `execution-boundary.test.ts:606` (executor refuses before reading the task), `:637` (both workflows end without an `AgentRun`), `:565` (two concurrent no-attempt validations create none). |
| `:95` | "running / **continued-as-new** → skip" | **unproven** | Implemented at `reaper.ts:155` and `:177` (`CONTINUED_AS_NEW` ⇒ `active`). No test names a continued-as-new execution. |
| `:98-103` | "one conditional `updateMany` … inside a transaction with an `execution.claim_released.v1` audit row … all three claim columns go NULL" | **proven** | `execution-boundary.test.ts:1140-1155` asserts the row state, the three NULLs, and exactly one audit row carrying the pair. |
| `:105-107` | "The module is imported by the reaper and by tests, and by nothing under `src/activities/`. `test/execution-boundary.test.ts` asserts that structurally" | **proven** | `execution-boundary.test.ts:2058` — "no activity module imports the claim-release module". |
| `:120` | "17/17 — F1 (×4), F2 (×2), F3 (×3), legitimate path + retry (×2), F4 (×5), structural (×1)" | **unproven** | The file contains exactly the 17 test titles in those groups (lines 320/362/396/435, 478/507, 565/606/637, 708/804, 1116/1166/1194/1230/1265, 2058). The **count** is verifiable by reading; "17/17" (all passing) cannot be verified without running, and no test asserts it. |
| `:139-142` | "The release pass kills nothing. A stranded claim never provisioned a process, so there is nothing to reap" | **unproven** | No test asserts that a claim release performs no kill. It follows from claim-before-provision, but it rests on code reading only. |

### `APPROVAL-ATOMIC-CLAIM-VERIFICATION.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:21-23` | "`count === 1` is the grant. The loser blocks on the row lock, re-evaluates … and matches nothing. There is no read-then-write" | **proven** | `execution-claim.test.ts:315` runs two concurrent claimants against real PostgreSQL and asserts exactly one grant total. A read-then-write implementation fails it. |
| `:23-25` | "the grant's audit row commits **in the same transaction**, so an attempt cannot be claimed without a record saying so" | **unproven** | Code: `claim.ts:307-332`. No test forces the transaction to roll back after the update and asserts the absence of both the claim and the event. The one-winner test proves the CAS, not the audit atomicity. |
| `:32-33` | "refused before the first read and before the claim write" | **proven** | `execution-identity.test.ts:259` (launch site, zero writes) and `:287` (validation, reservation unspent). |
| `:35-37` | "A lost claim is classified by identity, never permission: same run + `queued`/`running` → **retry**; different run → `EXECUTION_ALREADY_CLAIMED`; terminal → refused." | **proven** | `execution-claim.test.ts:268-315`, six pure decision tests covering exactly those cases, plus the concurrent one-winner test at `:315`. |
| `:76` | "Standalone activity cannot forge identity — 4 forged field names at once → `EXECUTION_IDENTITY_UNAVAILABLE`, `newAttempts=0`" | **proven** | `execution-identity.test.ts:467` sends `executionRunId` alongside the attempt and run ids on a real standalone activity; refused, one attempt row, no second attempt. |
| `:80` | "Live claim **never** released" | **proven** | `execution-boundary.test.ts:1194` (stub probe returns `active`; negative control), `:1534` (live under the canonical id), `:1592` (live under a non-canonical id), `:1230` (unanswerable probe ⇒ skip). The mechanism is `active`/`unknown` ⇒ skip; all four arms are exercised. |
| `:84-85` | "**Every** row above was verified by mutation — removing the control makes the test fail." | **overstated** | The document records mutations for *some* rows. `AG-604` §5 records five controls with the failing test named. Nothing in the Phase 6 record shows a mutation for "one winner under concurrency", "same run is idempotent", "no-attempt direct start refused" or "live claim never released". Those rows are backed by tests, not by a recorded mutation. |

### `CREDENTIAL-CUSTODY-ASSESSMENT.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:33-35` | "the sandbox **cannot** read the credential. It is not mounted, `/workspace` is the only writable bind, and it has no network to use a credential against." | **unproven** | `sandbox.test.ts:96` asserts exactly one writable `--bind` and `:51` measures blocked egress, and production passes no `readOnlyMounts` (`sandbox.ts:301-318`; no caller in `agent-runtime`/`worker`). But no test attempts to read `/home/ubuntu/.local/share/opencode/opencode.db` from inside the sandbox. The document's own standard at `:60-61` says that read attempt is what makes the claim enforced. |

### `PHASE6-GATE-MATRIX.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:45` (G-01) | "Initial snapshot precedes agent execution — **Verified** — source-position test + inline capture at `execute-agent.ts:613`" | **proven** | `evidence-capture-order.test.ts:58` asserts the source order (lease < baseline < cgroup < markExecuting < execute) and one launch site; `:89` performs a sandboxed write through the real mount profile and asserts the manifest reports it `added` — which fails if the baseline were captured after the write. |
| `:47` (G-03) | "**Verified** — `snapshot.ts` imports only `readdir/readFile/lstat/readlink`" | **false** | The actual import is `readdir`, `lstat`, `open`, `readlink` (`snapshot.ts:2-3`); there is no `readFile` import and `open` is omitted. The security property (no repository-configurable program) still holds and is separately tested at `snapshot.test.ts:346`; the enumerated list is wrong. |
| `:56` (G-12) | "Artifact authority server-controlled — **Verified** — `authoritative = evidence.authoritative && workspaceId !== null`; adapter candidate removed" | **proven** | `evidence-provenance.test.ts:626-652` (unbound ⇒ `false`), `:667-701` (bound but incomplete ⇒ `false`), `:432-474` (sibling workspace cannot win; forged authoritative incomplete body refused). |
| `:63` (G-21) | "four statements were measured false (same-size bound, parent-swap detection, nested-`.git` metadata, reaper 'any authority row')" | **proven** | This audit independently locates all four: `TRUSTED-SNAPSHOT-DESIGN.md:106-108`, `:41`, `:169-173`; `apps/worker/src/reaper.ts:525-528`. The matrix is accurate about its own documentation debt. |

### `REMEDIATION-REGISTER.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:42` | "N4 class — `emitEventActivity` / `recordStartActivity` unauthenticated — **CLOSED**" | **overstated** | Closed for `Task`-aggregate writes only: `emit-event.ts:73` gates `aggregateType === 'Task'`. The same register says so at `:51` (N15), and `TRUST-BOUNDARY-CLOSURE.md:151-157` names the five namespaces still writable by name. "N4 class" reads as the write class. |

### `EVIDENCE-INDEX.md`

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:80` | "Incomplete manifest is not authority — `change-manifest.test.ts:304,330` + `persist-result.ts:354`" | **proven**, citation defective | The property is proven, but not by the cited tests: `:304`/`:330` assert `manifest.complete === false`, not `Artifact.authoritative`. The test that fails if the authority gate is removed is `evidence-provenance.test.ts:667` (bound workspace, incomplete walk ⇒ `authoritative false`). Re-cite it. |

### `apps/worker/src/reaper.ts` — the "any authority row" claim

Recorded as a documentation finding by `PHASE6-GATE-MATRIX.md:63`; audited here because it
is the fourth reported sentence.

| Document:line | Claim | Verdict | Basis |
|---|---|---|---|
| `:525-528` | "**No authority row without readable bytes** … this is the guard that makes it an invariant rather than a convention" | **false** | The guard runs in `reapOne` for candidates whose state is **not** terminal (`reaper.ts:288` excludes `completed/failed/cancelled/cleaned/cleanup_failed/quarantined`) and in `runOrphanSweep` for `completed/failed` rows with `cleanedAt: null` (`:855-860`). A `cleaned` or `quarantined` row is in neither set and is never revisited. Test `reaper.test.ts:448` proves only the reap path. Measured: `FINAL-INDEPENDENT-REVIEW.md:2625-2636`. |

---

## 3. Counts by verdict

| Verdict | Count |
|---|---|
| **proven** | **38** |
| **unproven** | **13** |
| **false** | **7** |
| **overstated** | **6** |
| **Total rows** | **64** |

Documents with **no** security-property sentence requiring a row: `TEST-RESULTS.md`
(measurements and residuals), `ISOLATION-TEST-STABILITY.md` (test-flake analysis),
`PHASE5-COMMIT-AUDIT.md` (commit hygiene), `APPROVAL-TOCTOU-ROOT-CAUSE.md` (historical root
cause, with explicit residuals), and `FINAL-INDEPENDENT-REVIEW.md` (the audit input, not a
claim document). Their strong statements are historical or explicitly labelled as limits,
not assertions that a control holds. `REMEDIATION-REGISTER.md` is otherwise a status ledger
whose F-G/N rows match the findings above; its one overstatement is row `:42`.

---

## 4. Sentences that must be weakened or deleted

Only the rows that need action are listed. Everything marked **proven** is left alone.

### `TRUSTED-SNAPSHOT-DESIGN.md`

1. **`:41` — delete and replace the table row.** It asserts a capability the code does not
   have at `cfc1f26`, and the dangerous half (nested `.git` undescribed) is exactly the
   F-G11 write area. If the root-only walk ships, use:

   > | `.git` at the workspace root only | skipped in the walk and described by `SnapshotGitMetadata`; a `.git` at any other depth is content and is walked like any directory | `:844` |

   If it does not ship, the row must be:

   > | `.git` excluded at any depth | skipped in the walk; **only the root's** `.git` is described, so a nested `.git` is an undescribed write area (F-G11) | `:732` |

2. **`:106-108` — replace the compensating sentence.** Delete "The identity check makes the
   swap *detected* whenever the target is a different inode, which is every case except a
   same-inode/same-size substitution." Replacement:

   > The identity check detects a swap of the **final component**: `O_NOFOLLOW` refuses a
   > link, and `fstat`'s `dev`/`ino` refuse a different inode. It does **not** detect a
   > **parent** directory swapped for a link between `readdir` and the child's `lstat`: the
   > `lstat` happens after the swap, describes the link target, and the `fstat` agrees by
   > construction. Measured: a `complete: true` snapshot carrying `/etc/passwd`'s digest
   > (F-G5). Reaching the window requires a live writer during capture, which Gate G
   > excludes by assumption, not by code.

3. **`:67-68` — replace the detection sentence.** Do not say `size`/`mtimeMs` catch a
   rewrite. If the `ctime` fix ships:

   > **The descriptor did not change while it was read.** `size`, `mtimeMs` and `ctimeMs`
   > are re-read after hashing. A writer that appends or truncates moves `size`; a
   > same-size rewrite that restores `mtime` moves `ctime`, which an unprivileged process
   > cannot restore. Either is `unstable`. A rewrite that completed before the `lstat` is
   > simply the file's current content and is described as such.

   If it does not ship, the sentence must read: "a writer that changes the size, or changes
   the bytes without restoring `mtime`, is detected; a same-size rewrite with `mtime`
   restored is not."

4. **`:169-173` — delete the baseline bound.** Replace limitation 7 with:

   > 7. **A same-size rewrite is caught only while it overlaps the read.** `ctimeMs` is
   >    compared before and after, so a rewrite during capture is `unstable`. A write that
   >    completes before the `lstat` is the file's current content; a write that lands after
   >    the final snapshot but before persistence is not covered (adversarial-tests gap 3).

5. **`:165-167` — replace the non-UTF-8 limitation.** "Represented lossily" is false and
   understates the effect:

   > A name that is not valid UTF-8 cannot be carried by the string `readdir` API. The walk
   > attempts `lstat` on the lossy name, fails with `ENOENT`, and stops with
   > `complete: false`, `stopReason: 'unreadable'`; the entry is absent. It is not
   > represented lossily — it is not represented at all, and every later snapshot of the
   > workspace is incomplete until the name is removed.

6. **`:148-149` — narrow "the only skip is `.git`".**

   > There is no general exclusion mechanism and no agent-supplied pattern. The only
   > path-level skip is the workspace root's `.git` (`.`/`..`/separator names are rejected
   > defensively). `maxEntries`/`maxTotalBytes` can also stop the walk, which is reported as
   > `complete: false`.

7. **`:38` — add the parent-component caveat**, or the row contradicts `:106-108`:

   > Lexical containment of every path string … It is a check on the string, not on the
   > components: a path built from a symlinked parent passes it (see "What 'never descend
   > through a link' covers, exactly").

8. **`:44`** — delete "so a bounded walk stops in the same place on every host", or state
   that the sorted frontier is deterministic while no test asserts the cut point. **`:159-160`**
   — mark the hard-link behaviour as reasoned, not tested.

### `ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md`

9. **`:75` — replace the row.** It names a check that does not detect mutation:

   > `| file changes during read | size + `mtimeMs` + `ctimeMs` re-read after hashing (`snapshot.ts:405-423`) | a size change or a rewrite that moves `ctime` makes the entry `unstable`; a rewrite completed before the `lstat` is described as current content |`

10. **`:72` and `:74` — mark as implemented, not tested.** Either add the tests or write
    "code path; no test triggers it" in the Behaviour column. As written, the table reads as
    a list of exercised behaviours; two of the seven rows are not exercised.

### `AG-603-IDENTITY-AND-AUTHORITY.md`

11. **`:50` — replace the absolute.** "Nothing in `src/` reads an identity from a parameter"
    is contradicted by `claimExecution` and by the document's own point 4:

    > No activity input supplies an execution identity. `executionIdentity()` has no
    > parameter. The one internal writer, `claimExecution`, is *given* an identity by its
    > caller, and its only production caller derives it from the activity context.

12. **`:166` — split the conjunct.** Either add a test that seeds a running foreign attempt
    against an authorised pre-dispatch call, or state which half is tested:

    > the caller must be this task's own execution … and no attempt of this task may be
    > running or claimed by anybody else. The identity half is tested; the foreign-attempt
    > conjunct is code-only (`claim.ts:765-777`).

### `AG-604-CLAIM-IDENTITY-AND-WRITE-AUTHORITY.md`

13. **`:145-150` — delete "Its task never reaches a terminal state."** Replacement:

    > Its task cannot be advanced by the workflow: completion is refused for everyone,
    > including its own execution. An operator can still cancel it through `POST /cancel`,
    > which accepts a `running` task (`tasks.service.ts:1031`).

### `APPROVAL-ATOMIC-CLAIM-VERIFICATION.md`

14. **`:84-85` — replace "Every row above was verified by mutation".**

    > The five controls recorded in `AG-604` §5 were verified by mutation, each with the
    > failing test named. The remaining rows are backed by the tests cited, not by a
    > recorded mutation.

15. **`:23-25` — mark the audit-atomicity claim as inspection.** Either add the rollback
    test or write: "the audit row is written in the same transaction (`claim.ts:307-332`);
    this rests on inspection — no test forces a rollback."

### `REMEDIATION-REGISTER.md`

16. **`:42` — scope "N4 class CLOSED" to the two writers and the aggregate.**

    > N4 (the two named writers) — **CLOSED for `Task`-aggregate writes**.
    > `workflow.*`, `agent.*`, `approval.*`, `project.*` and `run.*` remain writable by
    > name (N15).

### `CREDENTIAL-CUSTODY-ASSESSMENT.md`

17. **`:33-35` — replace "cannot read" with what was measured.**

    > The credential is not mounted and the sandbox has no network. The bind set is asserted
    > to have exactly one writable mount (`sandbox.test.ts:96`) and egress is measured
    > blocked (`:51`), but no test attempts to read the store from inside the sandbox; the
    > "cannot" is an inspection result until that read is attempted and fails (see §"What
    > the next workstream must establish", item 4).

### `PHASE6-GATE-MATRIX.md`

18. **`:47` (G-03) — correct the import list.**

    > **Verified** — `snapshot.ts` imports `readdir`, `lstat`, `open` and `readlink` from
    > `node:fs/promises`, and no `child_process` (`snapshot.test.ts:346`); content is hashed
    > through a descriptor, not a repository-configurable program.

### `EVIDENCE-INDEX.md`

19. **`:80` — re-cite.** Replace `change-manifest.test.ts:304,330` with
    `evidence-provenance.test.ts:667` (and keep `persist-result.ts:365`). The cited tests do
    not assert authority and would stay green if the authority gate were deleted.

### `apps/worker/src/reaper.ts`

20. **`:525-528` — replace the heading and the invariant word.**

    > ── No authority row left behind by **this** pass without readable bytes ──
    >
    > … this is the guard that demotes an authoritative row whose bytes are gone at reclaim
    > time. It does not revisit rows already `cleaned` or `quarantined`; those keep their
    > authority until a repair sweep exists (F-G16).

---

## 5. The five most serious overstatements

Ranked by what a reviewer would stop testing because of the sentence.

1. **`TRUSTED-SNAPSHOT-DESIGN.md:106-108` — parent-swap detection (false).** The paragraph
   admits the window, then says the identity check detects every different-inode swap. It
   does not: the child `lstat` follows the swapped parent and `fstat` agrees. Measured as a
   **complete, authoritative** snapshot carrying `/etc/passwd`'s digest. This is the only
   finding here where the false sentence is the sole reason a host-file read looks covered.

2. **`TRUSTED-SNAPSHOT-DESIGN.md:41` — nested `.git` "recorded as metadata instead"
   (false).** At `cfc1f26` it was skipped at any depth and described nowhere; a write inside
   `sub/.git` produced `changeCount: 0` and a digest identical to baseline. A silent,
   deterministic write area in an "authoritative" manifest.

3. **`TRUSTED-SNAPSHOT-DESIGN.md:169-173` — "cannot make a changed file look unchanged
   against a baseline" (false).** Measured with an exact `mtime` restore: identical digests,
   zero changes, `authoritative: true`, file changed. The `ctime` fix is real but
   uncommitted and tested only at the descriptor level, not end to end.

4. **`apps/worker/src/reaper.ts:525-528` — "No authority row without readable bytes"
   (false).** The guard runs over non-terminal reap candidates and terminal rows with
   `cleanedAt: null`; a `cleaned` or `quarantined` row is never revisited. The Phase 6
   matrix already logs this, but the source comment still asserts the universal invariant a
   reader will trust.

5. **`TRUSTED-SNAPSHOT-DESIGN.md:165-167` — non-UTF-8 names "represented lossily"
   (false).** The walk stops with `unreadable` and the entry is absent. The sentence
   describes a harmless degradation; the behaviour is a one-`writeFile` way to hide a file
   and downgrade every later manifest of that workspace.

**Narrowly outside the five:** `CREDENTIAL-CUSTODY-ASSESSMENT.md:33` ("the sandbox cannot
read the credential") is the most consequential **unproven** claim — it is probably true,
but it is asserted with *cannot* on bind-set inspection, and the document itself says the
read attempt is what would prove it.

---

## Appendix A — drift between the documents and the uncommitted working tree

Not counted as verdicts above; recorded so the next reader does not mistake a stale-safe
sentence for a defect or a fixed defect for an open one.

| Document claim | At `cfc1f26` | Working tree (uncommitted) |
|---|---|---|
| `.git` excluded at any depth (`:41`) | true exclusion, root-only metadata ⇒ undescribed nested `.git` | **root-only exclusion**; nested `.git` walked as content; `snapshot-nested-git.test.ts` (untracked) asserts the write is reported |
| `ctime` not compared (`G-08`, limitation 7) | true; same-size rewrite with `mtime` restored hides a change | `ctimeMs` compared before and after (`snapshot.ts:388`, `:405-413`); `snapshot-race.test.ts:140` and `:175` assert the refusal |
| `mtime`-only after-check (`:67-68`) | overstates detection | `ctimeMs` closes the measured mechanism at the descriptor level; no end-to-end two-snapshot test yet |
| metadata anomalies in the digest only (F-G14) | true | `git.anomalies` added to the canonical body and `EvidenceSummary`; `SNAPSHOT_VERSION` 3 |
| an incomplete manifest still succeeds (F-G13) | true | `evidence.ts` returns an `EvidenceCaptureFailure` for an incomplete final walk; tests changed accordingly |

Any replacement wording in §4 that assumes the `ctime`/root-only fix must not be applied
until that fix is committed, or it will describe uncommitted behaviour.

## Appendix B — non-claim defects found while reading

- `PHASE6-GATE-MATRIX.md` has **two `G-20` rows** with different statuses: `:62` says
  **FAIL** (F-G11 open) and `:66` says **PENDING** (review in flight). One gate ID, two
  answers.
- `TRUSTED-SNAPSHOT-DESIGN.md:3-4` still says "independent review outstanding" and quotes
  "40 focused tests"; the review exists and returns FAIL. A status line, not a security
  claim, but it is the first thing a reader sees.
- `TRUSTED-SNAPSHOT-DESIGN.md:124` cites `persist-result.ts:365`; `:184` cites `:513`.
  Both exist at `cfc1f26`. No defect — recorded because several other documents cite
  `:354`, which no longer resolves to the authority line.
- `APPROVAL-ATOMIC-CLAIM-VERIFICATION.md:3` lists `58476b0` as under review while the
  verification table at `AG-604:10` uses `a75f121` as its base. The lineage is consistent;
  the header is just stale.

## Addendum (D-602) — correction status

Written after the corrections. These are not audit verdicts; they record what the follow-up
pass changed and what it could not.

| Finding | Where corrected | Status |
|---|---|---|
| The 7 **false** claims | `TRUSTED-SNAPSHOT-DESIGN.md`, `ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md`, `PHASE6-GATE-MATRIX.md`, `REMEDIATION-REGISTER.md` (D-01…D-07) | 6 corrected in documents. **D-07 is open**: `apps/worker/src/reaper.ts:525-528` is a source comment and D-602 may not edit source. It is item D-07 in the register and G-21 stays FAIL |
| The 6 **overstated** claims | Each document's correction table | Corrected; no `proven` sentence was weakened |
| The 13 **unproven** claims | Same | Each is now either backed by a cited test or labelled *code path, no test* |
| `CREDENTIAL-CUSTODY-ASSESSMENT.md:33` | That document, §"Correction history" | **NOT TESTED**, with the seven-step experiment and a positive control |
| Three post-audit host facts | `CREDENTIAL-CUSTODY-ASSESSMENT.md`, §"Three facts that outrank 'same uid'" | Measured in the D-602 addendum session: uid 1000 has passwordless `sudo` (`sudo -n whoami` → root) and is in `sudo`/`lxd`; `.local`/`share`/`opencode` are `0775` owned by uid 1000, so `0600` on the store is not the control; `mcp-auth.json` is a second secret in the same directory. Step 0 (remove `sudo`/`lxd`) is recorded as the precondition for Gate A, not part of it. `:33` remains **NOT TESTED** |
| Two `G-20` rows | `PHASE6-GATE-MATRIX.md` | Merged into one; the stale **PENDING** row is gone |
| Stale `9461d27` line citations in G-01/G-02 and `EVIDENCE-INDEX.md` | Both documents | Re-cited against `cfc1f26` |

**Drift this audit could not have seen.** `packages/workspace-manager/src/snapshot.ts` was
modified at 16:30, three minutes after this audit was written. Appendix A therefore does not
record **F-G20**: the working tree re-checks a directory's identity after its children are read
and, on `dev`/`ino` movement or a link, withdraws the contested subtree and stops with
`stopReason: 'parent-replaced'` (`snapshot.ts:1033-1060`; `directoryIdentityVerdict` at `:849`).
There is **no test** for it. The documents describe it as uncommitted, untested and
unreviewed — which is weaker than the audit's own replacement wording for `:104-108`, and
deliberately so: the detection is after the read, and the read still happens.

Appendix A says replacement wording that assumes the `ctime`/root-only fix "must not be applied
until that fix is committed". D-602 applied it, with every affected sentence labelled
*uncommitted*. A document that stays silent about an implemented-but-unreviewed fix is the same
drift in the other direction; the label is what keeps it honest until the fix is committed and
reviewed.
