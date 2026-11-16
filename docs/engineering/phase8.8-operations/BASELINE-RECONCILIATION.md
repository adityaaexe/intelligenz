# Phase 8.8 — baseline reconciliation

**Measured:** 2026-11-16, at the start of the Phase 8.8 session.
**Method:** commands run against the filesystem and the live host, not the session report.

---

## 1. Repository

| Item | Measured | Expected | Match |
|---|---|---|---|
| Branch | `phase-6/trust-boundary-closure` | same | ✅ |
| HEAD | `099d4a0f0e4c713ef18d53cb7cc0a140514f4295` | same | ✅ |
| Code head | `0b68b9ba11c9d96e128cd143156f2868b8ba74fa` | same | ✅ |
| Worktree | `git status --porcelain` empty | clean | ✅ |
| `git diff --check` | exit 0, no whitespace errors | — | ✅ |

`PROGRAMME-CHARTER.md` does **not** exist. The directive lists it as "if present"; it is not
present, and no charter was invented to satisfy a checklist.

## 2. Ledger

`pnpm programme:check` → **VALID**

| Field | Value |
|---|---|
| phase | `8.7` |
| tasks | 26 (completed 13, blocked 5, planned 8) |
| completed | `P83-001 P83-002 P83-012 P86-001 P86-002 P87-001 … P87-008` |
| open | `P83-003 … P83-011`, `P87-009 … P87-012` |
| updated | `2026-11-16T11:55:00.000Z` |

Note: the ledger's `head` is the **code** head `0b68b9b`, by the convention established when
`3e56ef8` (a docs commit) recorded `b4408e8`. It is not stale; it names the last commit that
changed behaviour.

## 3. Commits since Phase 8.6

| Commit | Kind | Subject |
|---|---|---|
| `34eaedf` | code | give a programme child its task's id, and make the reservation answer truthfully |
| `fced403` | code | define the proposal contract and the Plan row a decision binds to |
| `0a222ba` | code | propose plans that only a human, and only identical bytes, can authorise |
| `0b68b9b` | code | give a programme's stop reason a code, and cross its continue-as-new boundary |
| `099d4a0` | docs | record Phase 8.7 as PARTIAL, with the four reasons it is not PASS |

Nothing has been pushed: there is no remote.

## 4. Last measured verification — not re-presented as fresh

These were measured **before** this session, at the commits shown. They are recorded as
historical evidence. Phase 8.8 must re-measure before claiming anything current.

| Gate | Result | Commit measured |
|---|---|---|
| typecheck | exit 0 | `099d4a0` |
| lint (`--max-warnings=0`) | exit 0 | `099d4a0` |
| repo suite | 96 files, 1064 passed, 15 skipped | `0b68b9b` |
| API E2E | 159 passed, exit 0 ×3, 21 s each | `0b68b9b` |
| `prisma validate` | valid | `0b68b9b` |
| migrations | 10; dev + `_test` "up to date" | `0b68b9b` |
| `programme:check` | VALID | re-measured now |

## 5. Live host

| Service | State |
|---|---|
| Temporal frontend | `127.0.0.1:7233` (pid 387782, `server start-dev`) |
| Temporal UI | `127.0.0.1:8233` |
| PostgreSQL | `127.0.0.1:5432` |
| Redis | `6379` |
| INTELLIGENZ web | `*:3100` (pid 547839) |
| INTELLIGENZ API | `4100` — **not listening**; E2E boots its own instance |
| **Ports 3000 / 4000** | **owned by another application** (pids 1466223 / 1466250). Must not be stopped, probed destructively, or repurposed. |

## 6. Known unresolved failures and blockers

### 6.1 P87-011 — intermittent approval-binding E2E failure (highest priority)

| Fact | Value |
|---|---|
| Test | `apps/api/test/approval-attempt-binding.e2e-spec.ts` → *"1. two simultaneous POST /run — one attempt, one consumption"* → *"reserves exactly one attempt and one grant, and refuses the loser with 409"* |
| Observed | **1 failure in 8 full-suite runs**, then 7 consecutive passes; isolated run 12/12 |
| Failed run duration | 33.41 s (passing runs: ~21 s) |
| Assertion that failed | **Not captured.** Only the test name is known. |
| Product path touched by the concurrent commit | Verified: the planner commit did not modify the `POST /run` path (diff inspected) |
| Status | Open. A green re-run does not erase the original failure. |

The missing assertion is the crux. Without it, any "fixed" claim is a guess.

### 6.2 Open tasks

| ID | State | Blocker |
|---|---|---|
| P87-009 | blocked | governance decisions D1–D3 |
| P87-010 | planned | no programme-level cancel endpoint |
| P87-012 | planned | deadline return value contradicts the row (`blocked` vs `timed_out`) |
| P83-003/004 | blocked | operator authorisation for the sudoers/host change |
| P83-005 | blocked | no remote, no CI Temporal |
| P83-006 | blocked | no backup target, no drill |
| P83-007/008 | planned | per-attempt isolation; `maxConcurrent` stays 1 |
| P83-011 | blocked | two Phase 7 documents cited but absent |

## 7. What this baseline deliberately does not do

- It does not re-run the suite and label the result "current" — that happens in the task that
  needs it, with its own commit attached.
- It does not downgrade P87-011 to "probably flaky". The evidence is one failure with no
  captured assertion; that is "unresolved", not "benign".
- It does not start Phase 9. Phase 9 begins only after P87-011 and P87-010 are addressed or
  explicitly blocked, per §8 of the directive.
