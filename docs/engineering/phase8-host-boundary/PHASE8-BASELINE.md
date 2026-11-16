# Phase 8 — baseline and reconciliation

**Measured:** 2026-11-16 · **Branch:** `phase-6/trust-boundary-closure`
**HEAD:** `bd1c0b46cb398e48f779e32a079356c7c9926ad3` · **Tree:** clean (0 entries) · **Remote:** none

---

## 1. Repository identity

```
pwd                      /home/ubuntu/intelligenz
git rev-parse --show-toplevel   /home/ubuntu/intelligenz
git branch --show-current       phase-6/trust-boundary-closure
git rev-parse HEAD              bd1c0b46...9926ad3   (matches the directive's recorded baseline)
git worktree list               one worktree
git remote -v                   (none)
```

Historical commits, all resolving as `commit`:

`9461d27` · `cfc1f26` · `39063b9` · `c6eb96f` · `afef7bd` · `af835c7` · `bd1c0b4`

Linear ancestry. The Phase 7 matrix is in `bd1c0b4`, as recorded.

## 2. Concurrent writers

One `opencode.exe serve` process (the harness itself, pid 639292). **No vitest, no agent writer.** The tree is clean, so no partial work is in flight. There is nothing to preserve or reconcile.

## 3. Phase 7 documents — two of four do not exist

| Expected | Actual |
|---|---|
| `PHASE7-GATE-MATRIX.md` | **exists** |
| `HOST-PRIVILEGE-ASSESSMENT.md` | **exists** |
| `GATE-M-SUMMARY.md` | **MISSING** |
| `EVIDENCE-INDEX-PHASE7.md` | **MISSING** |

**This is a defect I introduced.** `PHASE7-GATE-MATRIX.md` row R-21 states:

> "Phase 6: 14/14. Phase 7: this matrix, `HOST-PRIVILEGE-ASSESSMENT.md`, `GATE-M-SUMMARY.md`, `EVIDENCE-INDEX-PHASE7.md`."

That sentence cites two deliverables that were never written, and it passed my own claim-audit habit because I checked the *matrix* against its claims and not the *citation list* against the filesystem. G-21 ("documentation claims are provable") applies to file references too.

**Correction applied:** R-21 is now marked PARTIAL with the two missing files named, and the citation is repaired rather than deleted so the error is visible.

## 4. Current gate state (unchanged since Phase 7)

| Gate | Status |
|---|---|
| Approval→execution (O1) | PASS |
| Gate G evidence | PASS (scoped; F-G20 open) |
| Gate M tenancy | PASS (43 tests, 4 mutation proofs) |
| CPU/memory | PARTIAL — 53 passed / 3 skipped |
| Disk | PASS |
| Output | PASS |
| I/O | BLOCKED |
| Dependencies | PASS — 3 advisories, 0 high/critical |
| CI | BLOCKED |
| Backup/restore | BLOCKED |
| Host privilege / credential custody | BLOCKED |
| Independent review of Phase 7 SHA | PARTIAL |
| **Production** | **NO-GO** |

## 5. Five discrepancies between the transcript and current state

| # | Transcript | Measured | Consequence |
|---|---|---|---|
| 1 | Implied `GATE-M-SUMMARY.md` and `EVIDENCE-INDEX-PHASE7.md` exist | **Neither exists** | My own R-21 citation was false. Repaired. |
| 2 | Swap "4.0 GiB total, 3.9 GiB used" | **4.0 GiB used — fully exhausted** | Operational, not security. Any workload that needs swap now stalls. |
| 3 | "`io.max` not writable → I/O BLOCKED" | True at `/sys/fs/cgroup/io.max`, but `/sys/fs/cgroup/intelligenz/cgroup.subtree_control` is **`cpu io memory pids`** | The earlier verdict measured the **root** cgroup. `io` **is** delegated to the worker's subtree, so I/O enforcement may be testable — R-13 must be re-examined, not left BLOCKED on a measurement of the wrong path. |
| 4 | cgroup delegation implied absent | `/sys/fs/cgroup/intelligenz` **exists, owned by `ubuntu`**, with a `worker` leaf | The 3 skipped kill tests are not "no delegation". They skip because the **test process runs inside a tmux scope**, and `cgroup.procs` migration needs both ends. A different problem with a different fix. |
| 5 | Credential store "0600, parents 0775" | **Exactly confirmed** — `opencode.db` and `mcp-auth.json` both `600 ubuntu:ubuntu`, parent `775` | The core finding stands unchanged. |

## 6. What the baseline changes about Phase 8

Two conclusions in Phase 7 were **too pessimistic for the wrong reason**, and one is **worse than recorded**:

- **I/O (R-13):** delegated, not blocked. The verdict rested on the root cgroup path.
- **cgroup kill tests (R-11):** the harness runs inside a tmux scope; the delegation exists and is worker-owned. The fix is how the suite is launched, not a missing capability.
- **Swap:** 100% consumed. Worse than recorded.

None of this touches the host-privilege conclusion. `sudo -n true` still returns root.

## 7. Blockers and authorisations required

| Item | Needs |
|---|---|
| Remove `(ALL) NOPASSWD: ALL` | **Authorisation** — sudoers |
| Remove `adm` (log access) | **Authorisation** |
| Create `izbroker` / `izsandbox` identities | **Authorisation** |
| Move credential store, restart services | **Authorisation** |
| Backup destination, CI remote | **Authorisation / infrastructure** |

Everything else in Phase 8 — inventory, design, unprivileged tests, documentation, dependency classification, local CI validation, isolated restore drill design — proceeds without authorisation.
