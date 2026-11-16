# Phase 6 — executive report

**Branch:** `phase-6/trust-boundary-closure` · **Code:** `39063b9` · **Docs:** `c6eb96f`
**Base:** `5bc69cf` (Phase 5) · **Push status:** NOT PUSHED, no remote configured
**Production:** **NO-GO — not authorised**

---

## 1. Verdict

| Gate | Result | Meaning |
|---|---|---|
| **H — approval→attempt (O1)** | **PASS** | No second execution authority for one reserved attempt. Four independent review rounds; the last could not reproduce a bypass |
| **G — artifact/diff integrity** | **PASS (scoped)**, `c6eb96f` | The agent cannot cause false evidence to be **accepted as authoritative**. It can still cause a *failed* run with a non-authoritative artifact — residual F-G20 |
| **J — activity write authority** | **PASS for `Task` / PARTIAL for the class** | Five other aggregate namespaces still writable by name |
| **I — claim release** | **PARTIAL** | Safety PASS; `cleaned`/`quarantined` rows keep authority over gone bytes by decision |
| **L — isolation flake** | **PASS** | Designed 15% bucket, not contention; 15 consecutive green runs |
| **A — credential custody** | **OPEN, and worse than recorded** | uid 1000 has **passwordless `sudo` to root** |
| M, N, O, P, Q, K | **OPEN / PARTIAL / BLOCKED** | See §7 |

**Phase 6 did not make the platform production-ready. It closed exactly two of the
questions it was authorised to close, and left the rest labelled.**

## 2. The one caveat on Gate G that must not be buried

The independent review's final position was **not** PASS. Round 3 withdrew two of its three
grounds — both of which I was able to disprove from the code — and left one:

> F-G20 is an unprevented TOCTOU. An off-tree digest **can** still be computed mid-walk.
> The snapshot then returns `complete: false, parent-replaced`, withdraws the subtree, and
> the attempt fails, so it **never becomes persisted authority**.

The reviewer offered two readings and declined to choose:

- **Stricter:** a window exists → FAIL.
- **"No accepted false authority":** detection is enough → no code ground left.

**I chose the second, and that choice is mine, not the reviewer's.** Gate G is therefore
closed by lead adjudication of a documented residual — not by an independent PASS. Rationale:

1. The gate's harm model is *"the agent shapes the evidence used to judge it."* A failed
   attempt with a `complete: false` artifact does not shape a judgement.
2. Impact was reclassified **High → Medium on measured behaviour**, not on the initial
   label: before the mitigation the outcome was a *complete, authoritative* snapshot
   carrying `/etc/passwd`'s hash; after it, the run fails and nothing authoritative is
   persisted.
3. What an attacker retains is a hash of a host file in a non-authoritative artifact — an
   offline confirmation oracle, not content disclosure.

**Trigger to close it properly:** a descriptor-relative walk — `openat2` with
`RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`, or `open(O_DIRECTORY|O_NOFOLLOW)` + `fstatat`.
Node cannot express either. **Not implemented, no native code added.** If that residual is
unacceptable, Gate G stays open and this section is why.

## 3. What Phase 6 actually built

### Authorization: four layers, each found by a reviewer

| Layer | Defect | Fix |
|---|---|---|
| 1 | Authorisation was a **check**, not a claim — read `queued`, returned `runnable`, wrote nothing | Durable one-shot claim: one conditional `updateMany` where the DB decides |
| 2 | The control sat **one activity upstream** of the side effect | Enforced at the only path to `runtime.execute` |
| 3 | Identity had a **convenience fallback** — a standalone activity could forge a victim's run id | `executionIdentity()` is zero-argument, context-only; identity fields deleted from inputs |
| 4 | The release probe asked a **derived** question (`task-<taskId>`), so a live claim was released | Release on the recorded `(workflowId, runId)` pair; reaper-only; unreachable from launch |

### Evidence: three measured attacks, then two rounds of being walked around

Measured **before** any code: `git add` (diff empty), a `clean` filter (`--no-textconv`
does not stop it — different mechanism), `git commit` (status *and* diff empty — a
confident negative).

All three closed and independently reproduced as closed. Then:

- **Round 1:** `.git/hooks → /etc` walked the tree (98 entries, `/etc/passwd`'s hash); and
  `chmod 000` made the final capture `null` while the task **succeeded**.
- **Round 2:** `sub/.git` excluded at every depth but described at none — an undescribed
  write area with a baseline-identical digest; and `ctime` was not compared, so a
  documented bound was false.

Three failure classes, and they are the lesson: **placement**, then **scope of
observation**, then **scope of description**.

## 4. What the review record is worth

Nine independent reviews across this phase. **Six failed a commit, and every failure was
real.** One found a High impersonation primitive; one found a live claim being released; two
found the evidence boundary walked around in opposite directions.

The record is only useful because it also contains the withdrawals: in round 3 the reviewer
withdrew two grounds, corrected its own line numbers, and **did not borrow an open row to
reach a verdict**. That is what makes the remaining finding credible.

## 5. Harness: three mechanisms that produced wrong numbers

Every one of these lied during *this* phase's verification:

| Mechanism | Symptom | Disposition |
|---|---|---|
| `hookTimeout: 10s` on real-Temporal suites | whole file **skipped**, summary reads as a pass — understated a reported count by one file | 60 s; 0 occurrences verified |
| `/tmp` tmpfs user quota | `errno 122 EDQUOT`, files abort, tests silently skip | caches cleared; documented |
| `TMPDIR` override | 116 → 109 bytes against a **107-byte unix socket limit**; 11 false failures, twice | use the documented default |

Plus: `seed.test.ts` asserted a **global** user count while `memberships` one line below was
org-scoped — a false red that misled two reviewers. And the harness `TRUNCATE`s its own
tables, so the orphan population it produced is now **unmeasurable**.

> A harness that lies is worse than one that fails.

## 6. Documentation as a gate row (G-21)

A claim audit classified **64 security claims: 38 proven, 13 unproven, 6 overstated,
7 false**. The false ones were not typos — they described the property intended rather than
the property built, and each was the thing a reviewer would rely on *instead of* testing:
parent-swap "detected", nested `.git` "recorded as metadata", "cannot make a changed file
look unchanged", non-UTF-8 names "represented lossily", the reaper's "no authority row
without readable bytes", and "the sandbox cannot read the credential" (marked **NOT TESTED**
— a stat is not an attempted read).

**Rule adopted: if no test proves the sentence, weaken the sentence — never the test.**

## 7. Still open, without rounding up

| Gate | Status | Why |
|---|---|---|
| **A** credential custody | **OPEN** | uid 1000 → root via passwordless `sudo`, in `sudo`/`lxd`; store `0600` but every parent `0775` owned by that uid, so `unlink`/`rename` defeats the mode; `mcp-auth.json` is a second secret; broker is in-process. **Step 0: remove the escalation path — minutes, no code, precondition for everything else** |
| M multi-tenancy | OPEN | Per-endpoint scoping verified; no adversarial cross-tenant suite |
| N I/O enforcement | PARTIAL | `io.max` writable; process migration denied outside the wrapper |
| O host-wide disk | OPEN | Per-attempt ceilings only |
| K CI | BLOCKED | No remote, no push credential, no Temporal service |
| P advisories | OPEN | 0 high/critical; lower severities unclassified |
| Q backup/retention | OPEN | — |

**Custody was understated in Phase 5 and is now corrected by measurement.** The honest
statement: a worker compromise today is **root**, plus every provider key in a 1.1 GB store,
plus operator session history, plus a second credential, in one read. A real boundary can
remove **disclosure**; it cannot remove **use** — the agent legitimately holds a socket to
the broker, capped at `maxRequests`.

## 8. Production position

**NO-GO.** Not because the gates are uninteresting, but because Gate A is open and its
failure mode is irreversible: un-disclosing data is not possible. The effective controls
below the trust boundary do not compensate for a worker that can become root.

Gate G's `PASS (scoped)` does not change that, and this report does not claim the platform
is production-ready. It claims two specific questions were closed, one within a stated
scope with a named residual, and the rest are labelled honestly.

## 9. Evidence

`PHASE5-COMMIT-AUDIT.md` · `ISOLATION-TEST-STABILITY.md` · `APPROVAL-TOCTOU-ROOT-CAUSE.md` ·
`APPROVAL-ATOMIC-CLAIM-VERIFICATION.md` · `ARTIFACT-INTEGRITY-ROOT-CAUSE.md` ·
`TRUSTED-SNAPSHOT-DESIGN.md` · `ARTIFACT-INTEGRITY-ADVERSARIAL-TESTS.md` ·
`CREDENTIAL-CUSTODY-ASSESSMENT.md` · `TEST-RESULTS.md` · `PHASE6-GATE-MATRIX.md` ·
`REMEDIATION-REGISTER.md` · `FINAL-INDEPENDENT-REVIEW.md` · `EVIDENCE-INDEX.md` ·
`DOC-CLAIM-AUDIT.md` · `HARNESS-HYGIENE.md` · `PHASE7-SCOPING.md`

**Verified at `c6eb96f`:** lint 0 · typecheck 0 · **917 passed / 15 skipped / 0 failed / 85
files** · api e2e 97 · build 0 · fresh-database migration of all 8 migrations.
**15 skips are environment gates** (cgroup full-tier, I/O, bwrap tier) — *not* live-Temporal,
as an earlier version of `TEST-RESULTS.md` wrongly stated.
